import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { SubagentAcceptedLifecycle } from "../../src/agent/subagent-lifecycle.ts";
import type { JsonlWriteRuntime } from "../../src/cli/agent-tree-store/jsonl.ts";
import {
  type AgentTreeStoreRuntime,
  createAgentTreeHistory,
} from "../../src/cli/agent-tree-store.ts";
import { createSessionStore } from "../../src/cli/session-store.ts";

class TestWriteError extends Error {
  constructor(stage: string) {
    super(`simulated partial ${stage} append`);
  }
}

function acceptedLifecycle(childAgentId: string): SubagentAcceptedLifecycle {
  return {
    delegationId: `parent:tool-${childAgentId}`,
    childAgentId,
    childRunId: `subagent-${childAgentId.slice("agent-".length)}`,
    parentRunId: "parent",
    parentToolCallId: `tool-${childAgentId}`,
    task: "Inspect the crash boundary.",
    focusPaths: ["src/module.ts"],
    providerId: "deepseek",
    model: "deepseek-chat",
    systemPrompt: "Read-only child instructions.",
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
  test.each([
    {
      stage: "running",
      marker: '"type":"agent_run_running"',
      recoveredStatus: "interrupted",
    },
    {
      stage: "result",
      marker: '"type":"agent_result"',
      recoveredStatus: "interrupted",
    },
    {
      stage: "transcript terminal",
      marker: '"type":"transcript_terminal"',
      recoveredStatus: "completed",
    },
    {
      stage: "lifecycle terminal",
      marker: '"type":"agent_run_terminal"',
      recoveredStatus: "completed",
    },
  ])(
    `Given the $stage append writes a partial JSONL record,
    When the saved history is reopened after the owner fails,
    Then rollback and recovery produce exactly one truthful terminal result`,
    async ({ marker, recoveredStatus }) => {
      const workspace = await mkdtemp(join(tmpdir(), "keel-agent-failpoint-"));
      const keelHome = join(workspace, ".keel-home");
      let now = 1_700_000_000_000;
      const baseRuntime = testRuntime(keelHome, () => now++);
      createSessionStore({
        sessionId: "partial-append",
        workspace,
        runtime: baseRuntime,
      });
      const lifecycle = acceptedLifecycle(
        "agent-33333333-3333-4333-8333-333333333333",
      );

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
          run.running();
          expect(() =>
            run.terminal({
              status: "completed",
              finalText: "Complete before the simulated crash.",
              error: null,
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
        `${lifecycle.childAgentId}.jsonl`,
      );
      await expect(readFile(transcriptPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
