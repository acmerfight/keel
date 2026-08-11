import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import {
  type AgentId,
  type ReadOnlySubagentAcceptedLifecycle,
  SubagentPersistenceError,
} from "../../src/agent/subagent-lifecycle.ts";
import { resolveBuiltinSubagentProfile } from "../../src/agent/subagent-profile.ts";
import {
  createDurableJsonlWriter,
  createPlatformDirectorySync,
  IndeterminateJsonlWriteError,
  type JsonlWriteRuntime,
  readRepairableJsonl,
} from "../../src/cli/agent-tree-store/jsonl.ts";
import { reconcileUnacceptedTranscripts } from "../../src/cli/agent-tree-store/transcript.ts";
import {
  type AgentTreeStoreRuntime,
  createAgentTreeHistory,
} from "../../src/cli/agent-tree-store.ts";
import { createSessionStore } from "../../src/cli/session-store.ts";

const explorerCapability = resolveBuiltinSubagentProfile("explorer").snapshot;

class TestWriteError extends Error {
  constructor(stage: string) {
    super(`simulated partial ${stage} append`);
  }
}

function acceptedLifecycle(
  childAgentId: AgentId,
): ReadOnlySubagentAcceptedLifecycle {
  return {
    delegationId: `parent:tool-${childAgentId}`,
    childAgentId,
    childRunId: `subagent-${childAgentId.slice("agent-".length)}`,
    parentRunId: "parent",
    parentToolCallId: `tool-${childAgentId}`,
    task: "Inspect the crash boundary.",
    focusPaths: ["src/module.ts"],
    mode: "foreground",
    providerId: "deepseek",
    model: "deepseek-chat",
    effort: null,
    systemPrompt: "Read-only child instructions.",
    threadCapabilityCeiling: explorerCapability,
    capability: explorerCapability,
    workspace: null,
    lineage: { kind: "root" },
  };
}

function partialAppendRuntime(marker: string): JsonlWriteRuntime {
  let failed = false;
  return {
    create: (filePath, content) => {
      writeFileSync(filePath, content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { kind: "written" };
    },
    append: (filePath, content) => {
      if (!failed && content.includes(marker)) {
        failed = true;
        appendFileSync(
          filePath,
          content.slice(0, Math.ceil(content.length / 2)),
        );
        throw new TestWriteError(marker);
      }
      appendFileSync(filePath, content);
    },
  };
}

function testRuntime(
  keelHome: string,
  now: () => number,
  agentTreeJsonlWrite?: JsonlWriteRuntime,
): AgentTreeStoreRuntime {
  return {
    env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
    now,
    ...(agentTreeJsonlWrite === undefined ? {} : { agentTreeJsonlWrite }),
  };
}

describe("Agent Tree Store Crash Boundaries", () => {
  test(`Given one pending child input is durable but the canonical result append is interrupted,
    When the saved history reopens,
    Then recovery preserves the input and reports its pending count on the interrupted Run`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-pending-input-recovery-"),
    );
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const sessionId = "pending-input-recovery";
    const baseRuntime = testRuntime(keelHome, () => now++);
    const lifecycle = acceptedLifecycle(
      "agent-10101010-1010-4010-8010-101010101010",
    );
    createSessionStore({ sessionId, workspace, runtime: baseRuntime });

    try {
      const history = createAgentTreeHistory({
        sessionId,
        runtime: testRuntime(
          keelHome,
          () => now++,
          partialAppendRuntime('"type":"agent_result"'),
        ),
      });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the crash boundary.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      const running = run.running();
      running.pendingInput([
        {
          role: "user",
          content: "Also inspect the caller boundary.",
          origin: { type: "runtime_subagent_input" },
        },
      ]);
      expect(() =>
        running.terminal({
          status: "failed",
          finalText: null,
          error: "provider failed before consuming the queued input",
          pendingInputCount: 1,
          workspace: null,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            uncachedInputTokens: 10,
            outputTokens: 0,
          },
          turns: 1,
          costUsd: 0.0001,
        }),
      ).toThrow("simulated partial");

      const recovered = createAgentTreeHistory({
        sessionId,
        runtime: baseRuntime,
      });
      const entry = recovered.entries()[0];
      expect(entry).toMatchObject({
        status: "interrupted",
        result: { status: "interrupted", pendingInputCount: 1 },
      });
      if (entry === undefined) throw new Error("missing recovered child Run");
      expect(recovered.messages(entry).at(-1)).toMatchObject({
        role: "user",
        content: "Also inspect the caller boundary.",
      });
      expect(recovered.transcript(entry)).toContain(
        '"type":"transcript_terminal","status":"interrupted","pendingInputCount":1',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a background child terminal event is durable but its delivery projection append is interrupted,
    When the saved history reopens,
    Then recovery prepares the same pending result and binds it to the unchanged canonical result`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-delivery-pending-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const sessionId = "pending-delivery-recovery";
    const baseRuntime = testRuntime(keelHome, () => now++);
    createSessionStore({ sessionId, workspace, runtime: baseRuntime });
    const lifecycle = {
      ...acceptedLifecycle("agent-12121212-1212-4212-8212-121212121212"),
      mode: "background" as const,
    };

    try {
      const history = createAgentTreeHistory({
        sessionId,
        runtime: testRuntime(
          keelHome,
          () => now++,
          partialAppendRuntime('"type":"agent_result_delivery_pending"'),
        ),
      });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the crash boundary.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      const running = run.running();
      expect(() =>
        running.terminal({
          status: "completed",
          finalText: "Durable child result.",
          error: null,
          pendingInputCount: 0,
          workspace: null,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            uncachedInputTokens: 10,
            outputTokens: 5,
          },
          turns: 1,
          costUsd: 0.0001,
        }),
      ).toThrow("simulated partial");

      const recovered = createAgentTreeHistory({
        sessionId,
        runtime: baseRuntime,
      });
      const pending = recovered.pendingResultDeliveries([]);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        sessionId,
        delegationId: lifecycle.delegationId,
        childAgentId: lifecycle.childAgentId,
      });

      const reopened = createAgentTreeHistory({
        sessionId,
        runtime: baseRuntime,
      });
      expect(reopened.pendingResultDeliveries([])).toEqual(pending);
      const eventsPath = join(
        keelHome,
        "sessions",
        sessionId,
        "agents",
        "events.jsonl",
      );
      const events = await readFile(eventsPath, "utf8");
      expect(events.match(/"type":"agent_result"/gu)).toHaveLength(1);
      expect(events.match(/"type":"agent_run_terminal"/gu)).toHaveLength(1);
      expect(
        events.match(/"type":"agent_result_delivery_pending"/gu),
      ).toHaveLength(1);
      const tamperedEvents = events.replace(
        '"finalText":"Durable child result."',
        '"finalText":"Tampered child result."',
      );
      expect(tamperedEvents).not.toBe(events);
      await writeFile(eventsPath, tamperedEvents, "utf8");
      expect(() =>
        createAgentTreeHistory({ sessionId, runtime: baseRuntime }),
      ).toThrow("delivery mismatches its canonical result");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the parent ledger contains a background completion but its delivered marker append is interrupted,
    When the saved history reopens and reconciles that parent message,
    Then it marks the same projection delivered once and never injects it again`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-delivery-mark-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const sessionId = "delivered-marker-recovery";
    const baseRuntime = testRuntime(keelHome, () => now++);
    createSessionStore({ sessionId, workspace, runtime: baseRuntime });
    const lifecycle = {
      ...acceptedLifecycle("agent-34343434-3434-4434-8434-343434343434"),
      mode: "background" as const,
    };

    try {
      const history = createAgentTreeHistory({
        sessionId,
        runtime: baseRuntime,
      });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the crash boundary.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      run.running().terminal({
        status: "completed",
        finalText: "Durable child result.",
        error: null,
        pendingInputCount: 0,
        workspace: null,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          uncachedInputTokens: 10,
          outputTokens: 5,
        },
        turns: 1,
        costUsd: 0.0001,
      });
      const delivery = history.pendingResultDeliveries([])[0];
      if (delivery === undefined) throw new Error("missing pending delivery");
      const { projection, ...reference } = delivery;
      const parentMessage: SessionMessage = {
        role: "user",
        content: projection,
        origin: { type: "runtime_subagent_notification" },
        subagentResultDelivery: reference,
      };
      expect(() =>
        history.pendingResultDeliveries([
          { ...parentMessage, content: `${projection}\ntampered` },
        ]),
      ).toThrow("mismatches the durable projection");

      const failing = createAgentTreeHistory({
        sessionId,
        runtime: testRuntime(
          keelHome,
          () => now++,
          partialAppendRuntime('"type":"agent_result_delivery_delivered"'),
        ),
      });
      expect(() => failing.pendingResultDeliveries([parentMessage])).toThrow(
        "simulated partial",
      );

      const recovered = createAgentTreeHistory({
        sessionId,
        runtime: baseRuntime,
      });
      expect(recovered.pendingResultDeliveries([parentMessage])).toEqual([]);
      const reopened = createAgentTreeHistory({
        sessionId,
        runtime: baseRuntime,
      });
      expect(reopened.pendingResultDeliveries([parentMessage])).toEqual([]);
      const events = await readFile(
        join(keelHome, "sessions", sessionId, "agents", "events.jsonl"),
        "utf8",
      );
      expect(
        events.match(/"type":"agent_result_delivery_delivered"/gu),
      ).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given recovery must synthesize an initialization for a running child,
    When that initialization write fails before the interrupted result is committed,
    Then a later recovery can retry without inheriting an impossible started result`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-recovery-init-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const sessionId = "recovery-initialization-failure";
    const runtime = testRuntime(keelHome, () => now++);
    const lifecycle = acceptedLifecycle(
      "agent-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      history.persistence.accepted(lifecycle).running();

      const failingRuntime = testRuntime(
        keelHome,
        () => now++,
        partialAppendRuntime('"type":"transcript_initialize"'),
      );
      expect(() =>
        createAgentTreeHistory({ sessionId, runtime: failingRuntime }),
      ).toThrow("simulated partial");

      const eventsPath = join(
        keelHome,
        "sessions",
        sessionId,
        "agents",
        "events.jsonl",
      );
      await expect(readFile(eventsPath, "utf8")).resolves.not.toContain(
        '"type":"agent_result"',
      );

      const recovered = createAgentTreeHistory({ sessionId, runtime });
      expect(recovered.entries()).toMatchObject([{ status: "interrupted" }]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given agent history runs on Windows where directory handles cannot be synced,
    When it creates nested history and later removes an orphan transcript,
    Then directory durability degrades to a no-op without blocking either operation`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-jsonl-win32-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const syncDirectory = createPlatformDirectorySync("win32", () => {
      throw new Error("Windows must not open a directory handle for fsync");
    });
    const runtime = testRuntime(keelHome, () => now++, {
      create: (filePath, content) => {
        writeFileSync(filePath, content, { flag: "wx", mode: 0o600 });
        return { kind: "written" };
      },
      append: (filePath, content) => appendFileSync(filePath, content),
      syncDirectory,
    });
    const sessionId = "win32-history";
    createSessionStore({ sessionId, workspace, runtime });

    try {
      createAgentTreeHistory({ sessionId, runtime });
      const transcriptsDirectory = join(
        keelHome,
        "sessions",
        sessionId,
        "agents",
        "transcripts",
      );
      const orphanPath = join(transcriptsDirectory, "subagent-deadbeef.jsonl");
      writeFileSync(orphanPath, "orphan", "utf8");

      createAgentTreeHistory({ sessionId, runtime });

      await expect(readFile(orphanPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given first-time nested directory syncing fails after creation,
    When the same writer and then a fresh writer retry,
    Then the first stays poisoned while the fresh writer revalidates the existing ancestor chain`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-jsonl-dir-retry-"));
    const nestedDirectory = join(workspace, "sessions", "one", "agents");
    const runtime: Pick<JsonlWriteRuntime, "create" | "append"> = {
      create: (filePath: string, content: string) => {
        writeFileSync(filePath, content, { flag: "wx", mode: 0o600 });
        return { kind: "written" };
      },
      append: (filePath: string, content: string) =>
        appendFileSync(filePath, content),
    };
    const failedWriter = createDurableJsonlWriter({
      ...runtime,
      syncDirectory: () => {
        throw new Error("first directory fsync failed");
      },
    });

    try {
      expect(() => failedWriter.ensureDirectory(nestedDirectory)).toThrow(
        IndeterminateJsonlWriteError,
      );
      expect(() => failedWriter.ensureDirectory(nestedDirectory)).toThrow(
        IndeterminateJsonlWriteError,
      );

      const syncedDirectories: string[] = [];
      const retryWriter = createDurableJsonlWriter({
        ...runtime,
        syncDirectory: (directory) => syncedDirectories.push(directory),
      });
      retryWriter.ensureDirectory(nestedDirectory);
      retryWriter.create(
        join(nestedDirectory, "events.jsonl"),
        { type: "header" },
        "agent tree",
      );

      expect(syncedDirectories).toContain(dirname(nestedDirectory));
      await expect(
        readFile(join(nestedDirectory, "events.jsonl"), "utf8"),
      ).resolves.toContain('"type":"header"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given exclusive JSONL creation finds an existing ledger,
    When creation is rejected before this writer owns the path,
    Then the existing ledger remains byte-for-byte unchanged`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-jsonl-existing-"));
    const filePath = join(workspace, "events.jsonl");
    const original = '{"type":"existing"}\n';
    writeFileSync(filePath, original);

    try {
      const writer = createDurableJsonlWriter();
      expect(() =>
        writer.create(filePath, { type: "replacement" }, "agent tree"),
      ).toThrow("cannot create agent tree");
      await expect(readFile(filePath, "utf8")).resolves.toBe(original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given durable JSONL creation, inspection, and append rollback fail at their filesystem boundaries,
    When callers retry the same writer,
    Then partial files are removed where possible and every poisoned writer stays fail closed`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-jsonl-failpoint-"));
    const partialCreatePath = join(workspace, "partial-create.jsonl");
    const createFailure = new TestWriteError("create");
    const createWriter = createDurableJsonlWriter({
      create: (filePath, content) => {
        writeFileSync(filePath, content);
        return {
          kind: "failed",
          ownership: "owned",
          error: createFailure,
        };
      },
      append: () => {
        throw new Error("append is not used");
      },
    });

    try {
      expect(() =>
        createWriter.create(
          partialCreatePath,
          { type: "header" },
          "agent tree",
        ),
      ).toThrow("cannot create agent tree");
      await expect(readFile(partialCreatePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(() =>
        createWriter.create(
          join(workspace, "retry.jsonl"),
          { type: "header" },
          "agent tree",
        ),
      ).toThrow("cannot create agent tree");

      const missingWriter = createDurableJsonlWriter({
        create: () => ({ kind: "written" }),
        append: () => {},
      });
      expect(() =>
        missingWriter.append(
          join(workspace, "missing.jsonl"),
          { type: "record" },
          "agent tree",
        ),
      ).toThrow("cannot inspect agent tree");
      expect(() =>
        missingWriter.append(
          join(workspace, "still-missing.jsonl"),
          { type: "record" },
          "agent tree",
        ),
      ).toThrow("cannot inspect agent tree");

      const indeterminatePath = join(workspace, "indeterminate.jsonl");
      writeFileSync(indeterminatePath, '{"type":"header"}\n');
      const indeterminateWriter = createDurableJsonlWriter({
        create: () => ({ kind: "written" }),
        append: (filePath, content) => {
          appendFileSync(filePath, content.slice(0, 4));
          rmSync(filePath);
          mkdirSync(filePath);
          throw new TestWriteError("append");
        },
      });
      expect(() =>
        indeterminateWriter.append(
          indeterminatePath,
          { type: "record" },
          "agent tree",
        ),
      ).toThrow(IndeterminateJsonlWriteError);
      expect(() =>
        indeterminateWriter.append(
          indeterminatePath,
          { type: "retry" },
          "agent tree",
        ),
      ).toThrow(IndeterminateJsonlWriteError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a new JSONL file cannot durably publish or remove its directory entry,
    When create reaches either directory-sync boundary,
    Then the writer reports indeterminate state and remains poisoned`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-jsonl-dir-sync-"));
    const publishPath = join(workspace, "publish.jsonl");
    const cleanupPath = join(workspace, "cleanup.jsonl");
    const directoryFailure = new Error("directory fsync failed");
    const createFile = (filePath: string, content: string): void => {
      writeFileSync(filePath, content, { flag: "wx", mode: 0o600 });
    };

    try {
      const publishWriter = createDurableJsonlWriter({
        create: (filePath, content) => {
          createFile(filePath, content);
          return { kind: "written" };
        },
        append: () => {},
        syncDirectory: (directory) => {
          if (directory === workspace) throw directoryFailure;
        },
      });
      expect(() =>
        publishWriter.create(publishPath, { type: "header" }, "agent tree"),
      ).toThrow(IndeterminateJsonlWriteError);
      expect(() =>
        publishWriter.create(
          join(workspace, "publish-retry.jsonl"),
          { type: "header" },
          "agent tree",
        ),
      ).toThrow(IndeterminateJsonlWriteError);

      const cleanupWriter = createDurableJsonlWriter({
        create: (filePath, content) => {
          createFile(filePath, content);
          return {
            kind: "failed",
            ownership: "owned",
            error: new Error("file fsync failed"),
          };
        },
        append: () => {},
        syncDirectory: (directory) => {
          if (directory === workspace) throw directoryFailure;
        },
      });
      expect(() =>
        cleanupWriter.create(cleanupPath, { type: "header" }, "agent tree"),
      ).toThrow(IndeterminateJsonlWriteError);
      await expect(readFile(cleanupPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given bounded JSONL input is missing, oversized, invalid UTF-8, or lacks a recoverable header,
    When the durable reader opens it,
    Then corrupt input fails closed while a complete unterminated record is repaired`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-jsonl-read-"));

    try {
      expect(() =>
        readRepairableJsonl(join(workspace, "missing.jsonl"), 100),
      ).toThrow("cannot read");
      const unreadablePath = join(workspace, "unreadable.jsonl");
      mkdirSync(unreadablePath);
      expect(() =>
        readRepairableJsonl(unreadablePath, Number.MAX_SAFE_INTEGER),
      ).toThrow("cannot read");

      const oversizedPath = join(workspace, "oversized.jsonl");
      writeFileSync(oversizedPath, "1234");
      expect(() => readRepairableJsonl(oversizedPath, 3)).toThrow(
        "is too large",
      );

      const invalidUtf8Path = join(workspace, "invalid-utf8.jsonl");
      writeFileSync(invalidUtf8Path, Buffer.from([0xff, 0x0a]));
      expect(() => readRepairableJsonl(invalidUtf8Path, 100)).toThrow(
        "cannot decode",
      );

      const incompleteHeaderPath = join(workspace, "incomplete-header.jsonl");
      writeFileSync(incompleteHeaderPath, '{"type":"header"}');
      expect(() => readRepairableJsonl(incompleteHeaderPath, 100)).toThrow(
        "cannot recover incomplete JSONL header",
      );
      expect(() =>
        reconcileUnacceptedTranscripts(incompleteHeaderPath, new Set()),
      ).toThrow("cannot inspect agent transcripts");

      const completeTailPath = join(workspace, "complete-tail.jsonl");
      writeFileSync(completeTailPath, '{"type":"header"}\n{"type":"complete"}');
      expect(readRepairableJsonl(completeTailPath, 100)).toBe(
        '{"type":"header"}\n{"type":"complete"}\n',
      );
      await expect(readFile(completeTailPath, "utf8")).resolves.toBe(
        '{"type":"header"}\n{"type":"complete"}\n',
      );

      const readOnlyCompleteTailPath = join(
        workspace,
        "read-only-complete-tail.jsonl",
      );
      writeFileSync(
        readOnlyCompleteTailPath,
        '{"type":"header"}\n{"type":"complete"}',
      );
      chmodSync(readOnlyCompleteTailPath, 0o400);
      expect(() => readRepairableJsonl(readOnlyCompleteTailPath, 100)).toThrow(
        "cannot complete JSONL tail",
      );

      const readOnlyTornTailPath = join(workspace, "read-only-torn-tail.jsonl");
      writeFileSync(readOnlyTornTailPath, '{"type":"header"}\n{"type":"torn"');
      chmodSync(readOnlyTornTailPath, 0o400);
      expect(() => readRepairableJsonl(readOnlyTornTailPath, 100)).toThrow(
        "cannot repair incomplete JSONL tail",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given durable acceptance writes a partial record and rollback cannot establish whether it committed,
    When the store attempts to admit the child,
    Then admission fails fatally without deleting the possibly accepted transcript`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-failpoint-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const lifecycle = acceptedLifecycle(
      "agent-77777777-7777-4777-8777-777777777777",
    );
    const runtime = testRuntime(keelHome, () => now++, {
      create: (filePath, content) => {
        writeFileSync(filePath, content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        return { kind: "written" };
      },
      append: (filePath, content) => {
        if (content.includes('"type":"agent_run_accepted"')) {
          appendFileSync(filePath, content.slice(0, 8));
          rmSync(filePath);
          mkdirSync(filePath);
          throw new TestWriteError("accepted");
        }
        appendFileSync(filePath, content);
      },
    });
    createSessionStore({
      sessionId: "indeterminate-acceptance",
      workspace,
      runtime,
    });

    try {
      const history = createAgentTreeHistory({
        sessionId: "indeterminate-acceptance",
        runtime,
      });
      expect(() => history.persistence.accepted(lifecycle)).toThrow(
        SubagentPersistenceError,
      );
      expect(history.entries()).toEqual([]);
      await expect(
        readFile(
          join(
            keelHome,
            "sessions",
            "indeterminate-acceptance",
            "agents",
            "transcripts",
            `${lifecycle.childRunId}.jsonl`,
          ),
          "utf8",
        ),
      ).resolves.toContain('"type":"transcript"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a rejection receipt append is partial and rollback cannot establish whether it committed,
    When the store records the hard rejection,
    Then it raises a fatal persistence error instead of returning a normal rejection`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-failpoint-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = testRuntime(keelHome, () => now++, {
      create: (filePath, content) => {
        writeFileSync(filePath, content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        return { kind: "written" };
      },
      append: (filePath, content) => {
        if (content.includes('"type":"delegation_rejected"')) {
          appendFileSync(filePath, content.slice(0, 8));
          rmSync(filePath);
          mkdirSync(filePath);
          throw new TestWriteError("rejection");
        }
        appendFileSync(filePath, content);
      },
    });
    createSessionStore({
      sessionId: "indeterminate-rejection",
      workspace,
      runtime,
    });

    try {
      const history = createAgentTreeHistory({
        sessionId: "indeterminate-rejection",
        runtime,
      });
      expect(() =>
        history.persistence.rejected({
          delegationId: "parent:rejected",
          parentRunId: "parent",
          parentToolCallId: "rejected",
          task: "Reject this child.",
          reason: "Admission is unavailable.",
        }),
      ).toThrow(SubagentPersistenceError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a rejection receipt append is partial but rollback restores the ledger,
    When the store reports the recoverable write failure,
    Then no rejection record remains and reopening the session stays valid`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-failpoint-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const sessionId = "recoverable-rejection";
    const runtime = testRuntime(
      keelHome,
      () => now++,
      partialAppendRuntime('"type":"delegation_rejected"'),
    );
    createSessionStore({ sessionId, workspace, runtime });

    try {
      const history = createAgentTreeHistory({ sessionId, runtime });
      expect(() =>
        history.persistence.rejected({
          delegationId: "parent:recoverable-rejection",
          parentRunId: "parent",
          parentToolCallId: "recoverable-rejection",
          task: "Reject without retaining a partial receipt.",
          reason: "Admission is unavailable.",
        }),
      ).toThrow("simulated partial");
      const eventsPath = join(
        keelHome,
        "sessions",
        sessionId,
        "agents",
        "events.jsonl",
      );
      await expect(readFile(eventsPath, "utf8")).resolves.not.toContain(
        '"type":"delegation_rejected"',
      );
      expect(
        createAgentTreeHistory({
          sessionId,
          runtime: testRuntime(keelHome, () => now++),
        }).entries(),
      ).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given acceptance fails after transcript setup and provisional transcript cleanup also fails,
    When the store rolls admission back,
    Then the cleanup failure is fatal and no AgentRun becomes visible`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-failpoint-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const lifecycle = acceptedLifecycle(
      "agent-88888888-8888-4888-8888-888888888888",
    );
    const transcriptPath = join(
      keelHome,
      "sessions",
      "cleanup-failure",
      "agents",
      "transcripts",
      `${lifecycle.childRunId}.jsonl`,
    );
    const runtime = testRuntime(keelHome, () => now++, {
      create: (filePath, content) => {
        writeFileSync(filePath, content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        return { kind: "written" };
      },
      append: (filePath, content) => {
        if (content.includes('"type":"agent_run_accepted"')) {
          rmSync(transcriptPath);
          mkdirSync(transcriptPath);
          throw new TestWriteError("accepted");
        }
        appendFileSync(filePath, content);
      },
    });
    createSessionStore({
      sessionId: "cleanup-failure",
      workspace,
      runtime,
    });

    try {
      const history = createAgentTreeHistory({
        sessionId: "cleanup-failure",
        runtime,
      });
      expect(() => history.persistence.accepted(lifecycle)).toThrow(
        "cannot remove uncommitted agent transcript",
      );
      expect(() => history.persistence.accepted(lifecycle)).toThrow(
        SubagentPersistenceError,
      );
      expect(history.entries()).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      stage: "running",
      marker: '"type":"agent_run_running"',
      recoveredStatus: "interrupted",
      mode: "foreground" as const,
    },
    {
      stage: "result",
      marker: '"type":"agent_result"',
      recoveredStatus: "interrupted",
      mode: "foreground" as const,
    },
    {
      stage: "transcript terminal",
      marker: '"type":"transcript_terminal"',
      recoveredStatus: "completed",
      mode: "foreground" as const,
    },
    {
      stage: "lifecycle terminal",
      marker: '"type":"agent_run_terminal"',
      recoveredStatus: "completed",
      mode: "foreground" as const,
    },
    {
      stage: "background lifecycle terminal",
      marker: '"type":"agent_run_terminal"',
      recoveredStatus: "completed",
      mode: "background" as const,
    },
  ])(
    `Given the $stage append writes a partial JSONL record,
    When the saved history is reopened after the owner fails,
    Then rollback and recovery produce exactly one truthful terminal result`,
    async ({ marker, recoveredStatus, mode }) => {
      const workspace = await mkdtemp(join(tmpdir(), "keel-agent-failpoint-"));
      const keelHome = join(workspace, ".keel-home");
      let now = 1_700_000_000_000;
      const baseRuntime = testRuntime(keelHome, () => now++);
      createSessionStore({
        sessionId: "partial-append",
        workspace,
        runtime: baseRuntime,
      });
      const lifecycle = {
        ...acceptedLifecycle("agent-33333333-3333-4333-8333-333333333333"),
        mode,
      };

      try {
        const history = createAgentTreeHistory({
          sessionId: "partial-append",
          runtime: testRuntime(
            keelHome,
            () => now++,
            partialAppendRuntime(marker),
          ),
        });
        const run = history.persistence.accepted(lifecycle);
        run.transcript.initialize([
          {
            role: "user",
            content: "Inspect the crash boundary.",
            origin: { type: "runtime_subagent_delegation" },
          },
        ]);
        if (marker.includes("agent_run_running")) {
          expect(() => run.running()).toThrow("simulated partial");
        } else {
          const running = run.running();
          expect(() =>
            running.terminal({
              status: "completed",
              finalText: "Complete before the simulated crash.",
              error: null,
              pendingInputCount: 0,
              workspace: null,
              usage: {
                inputTokens: 10,
                cachedInputTokens: 0,
                uncachedInputTokens: 10,
                outputTokens: 5,
              },
              turns: 1,
              costUsd: 0.0001,
            }),
          ).toThrow("simulated partial");
        }

        const reopened = createAgentTreeHistory({
          sessionId: "partial-append",
          runtime: testRuntime(keelHome, () => now++),
        });
        expect(reopened.entries()).toMatchObject([
          { status: recoveredStatus, result: { status: recoveredStatus } },
        ]);
        const events = await readFile(
          join(
            keelHome,
            "sessions",
            "partial-append",
            "agents",
            "events.jsonl",
          ),
          "utf8",
        );
        expect(events.match(/"type":"agent_result"/gu)).toHaveLength(1);
        expect(events.match(/"type":"agent_run_terminal"/gu)).toHaveLength(1);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given transcript setup succeeds but durable acceptance fails,
    When the store rejects admission and is reopened,
    Then no AgentRun or unreferenced transcript remains`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-failpoint-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const baseRuntime = testRuntime(keelHome, () => now++);
    createSessionStore({
      sessionId: "acceptance-rollback",
      workspace,
      runtime: baseRuntime,
    });
    const lifecycle = acceptedLifecycle(
      "agent-44444444-4444-4444-8444-444444444444",
    );

    try {
      const history = createAgentTreeHistory({
        sessionId: "acceptance-rollback",
        runtime: testRuntime(
          keelHome,
          () => now++,
          partialAppendRuntime('"type":"agent_run_accepted"'),
        ),
      });
      expect(() => history.persistence.accepted(lifecycle)).toThrow(
        "simulated partial",
      );
      expect(history.entries()).toEqual([]);

      const reopened = createAgentTreeHistory({
        sessionId: "acceptance-rollback",
        runtime: testRuntime(keelHome, () => now++),
      });
      expect(reopened.entries()).toEqual([]);
      const transcriptPath = join(
        keelHome,
        "sessions",
        "acceptance-rollback",
        "agents",
        "transcripts",
        `${lifecycle.childRunId}.jsonl`,
      );
      await expect(readFile(transcriptPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
