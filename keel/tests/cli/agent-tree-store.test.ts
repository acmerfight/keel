import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { SubagentAcceptedLifecycle } from "../../src/agent/subagent-lifecycle.ts";
import { createAgentTreeHistory } from "../../src/cli/agent-tree-store.ts";
import { createSessionStore } from "../../src/cli/session-store.ts";

function acceptedLifecycle(
  childAgentId: string,
  childRunId: string,
): SubagentAcceptedLifecycle {
  return {
    delegationId: `parent:tool-${childAgentId}`,
    childAgentId,
    childRunId,
    parentRunId: "parent",
    parentToolCallId: `tool-${childAgentId}`,
    task: "Inspect the durable child lifecycle.",
    focusPaths: ["src/module.ts"],
    providerId: "deepseek",
    model: "deepseek-chat",
    systemPrompt: "Read-only child instructions.",
  };
}

describe("Agent Tree Store", () => {
  test(`Given a completed child has a canonical result and transcript,
    When the saved session history is opened again,
    Then its terminal facts remain unchanged and are not duplicated`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    createSessionStore({ sessionId: "completed", workspace, runtime });
    const lifecycle = acceptedLifecycle(
      "agent-11111111-1111-4111-8111-111111111111",
      "subagent-11111111-1111-4111-8111-111111111111",
    );

    try {
      const history = createAgentTreeHistory({
        sessionId: "completed",
        runtime,
      });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the module.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      run.running();
      run.accounting({
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          uncachedInputTokens: 100,
          outputTokens: 20,
        },
        turns: 1,
        costUsd: 0.00014,
      });
      run.terminal({
        status: "completed",
        finalText: "The module exports 42.",
        error: null,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 0,
          uncachedInputTokens: 100,
          outputTokens: 20,
        },
        turns: 1,
        costUsd: 0.00014,
      });
      const eventPath = join(
        keelHome,
        "sessions",
        "completed",
        "agents",
        "events.jsonl",
      );
      const beforeCrash = (await readFile(eventPath, "utf8"))
        .trimEnd()
        .split("\n");
      expect(beforeCrash.at(-1)).toContain('"type":"agent_run_terminal"');
      await writeFile(
        eventPath,
        `${beforeCrash.slice(0, -1).join("\n")}\n`,
        "utf8",
      );

      const reopened = createAgentTreeHistory({
        sessionId: "completed",
        runtime,
      });
      expect(reopened.entries()).toMatchObject([
        {
          status: "completed",
          result: {
            status: "completed",
            finalText: "The module exports 42.",
          },
        },
      ]);
      const events = await readFile(eventPath, "utf8");
      expect(events.match(/"type":"agent_result"/gu)).toHaveLength(1);
      expect(events.match(/"type":"agent_run_terminal"/gu)).toHaveLength(1);
      const transcriptPath = join(
        keelHome,
        "sessions",
        "completed",
        "agents",
        "transcripts",
        `${lifecycle.childAgentId}.jsonl`,
      );
      const transcriptLines = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n");
      expect(transcriptLines.at(-1)).toContain('"type":"transcript_terminal"');
      await writeFile(
        transcriptPath,
        `${transcriptLines.slice(0, -1).join("\n")}\n`,
        "utf8",
      );
      createAgentTreeHistory({ sessionId: "completed", runtime });
      expect(
        (await readFile(transcriptPath, "utf8")).match(
          /"type":"transcript_terminal"/gu,
        ),
      ).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a child with Unicode lifecycle data was running when its saved-session owner exited,
    When the exclusive owner opens the history repeatedly,
    Then recovery writes one interrupted result and marks the partial transcript incomplete`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    createSessionStore({ sessionId: "interrupted", workspace, runtime });
    const lifecycle: SubagentAcceptedLifecycle = {
      ...acceptedLifecycle(
        "agent-22222222-2222-4222-8222-222222222222",
        "subagent-22222222-2222-4222-8222-222222222222",
      ),
      task: "检查持久化的 child 生命周期。",
      systemPrompt: "只读调查；保留可信证据。",
    };

    try {
      const history = createAgentTreeHistory({
        sessionId: "interrupted",
        runtime,
      });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the module.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      run.transcript.append([
        {
          role: "assistant",
          content: "partial evidence",
          toolCalls: [],
        },
      ]);
      run.running();
      run.accounting({
        usage: {
          inputTokens: 80,
          cachedInputTokens: 0,
          uncachedInputTokens: 80,
          outputTokens: 10,
        },
        turns: 1,
        costUsd: 0.0001,
      });
      await appendFile(
        join(keelHome, "sessions", "interrupted", "agents", "events.jsonl"),
        '{"schemaVersion":1,"type":"agent_result"',
        "utf8",
      );
      await appendFile(
        join(
          keelHome,
          "sessions",
          "interrupted",
          "agents",
          "transcripts",
          `${lifecycle.childAgentId}.jsonl`,
        ),
        '{"schemaVersion":1,"type":"transcript_append"',
        "utf8",
      );

      const recovered = createAgentTreeHistory({
        sessionId: "interrupted",
        runtime,
      });
      expect(recovered.entries()).toMatchObject([
        {
          status: "interrupted",
          accounting: { turns: 1, costUsd: 0.0001 },
          result: { status: "interrupted" },
        },
      ]);
      expect(recovered.transcript(lifecycle.childAgentId)).toContain(
        '"type":"transcript_terminal","status":"interrupted","complete":false',
      );

      const reopenedAgain = createAgentTreeHistory({
        sessionId: "interrupted",
        runtime,
      });
      expect(reopenedAgain.entries()).toMatchObject([
        { status: "interrupted" },
      ]);
      const events = await readFile(
        join(keelHome, "sessions", "interrupted", "agents", "events.jsonl"),
        "utf8",
      );
      expect(events.match(/"type":"agent_result"/gu)).toHaveLength(1);
      expect(events.match(/"type":"agent_run_terminal"/gu)).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a saved child transcript contradicts its acceptance or has an invalid middle record,
    When local history inspection reads that transcript,
    Then the disk trust boundary fails closed instead of rendering raw content`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tree-"));
    const keelHome = join(workspace, ".keel-home");
    let now = 1_700_000_000_000;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => now++,
    };
    createSessionStore({ sessionId: "corrupt-transcript", workspace, runtime });
    const lifecycle = acceptedLifecycle(
      "agent-55555555-5555-4555-8555-555555555555",
      "subagent-55555555-5555-4555-8555-555555555555",
    );

    try {
      const history = createAgentTreeHistory({
        sessionId: "corrupt-transcript",
        runtime,
      });
      const run = history.persistence.accepted(lifecycle);
      run.transcript.initialize([
        {
          role: "user",
          content: "Inspect the module.",
          origin: { type: "runtime_subagent_delegation" },
        },
      ]);
      run.running();
      run.terminal({
        status: "completed",
        finalText: "Done.",
        error: null,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          uncachedInputTokens: 10,
          outputTokens: 2,
        },
        turns: 1,
        costUsd: 0.0001,
      });
      const transcriptPath = join(
        keelHome,
        "sessions",
        "corrupt-transcript",
        "agents",
        "transcripts",
        `${lifecycle.childAgentId}.jsonl`,
      );
      const lines = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n");
      const originalHeader = lines[0];
      if (originalHeader === undefined)
        throw new Error("missing transcript header");
      const terminalIndex = lines.length - 1;
      const originalTerminal = lines[terminalIndex];
      if (originalTerminal === undefined)
        throw new Error("missing transcript terminal");
      lines[terminalIndex] = originalTerminal.replace(
        '"status":"completed"',
        '"status":"failed"',
      );
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
      expect(() => history.transcript(lifecycle.childAgentId)).toThrow(
        "conflicting terminal",
      );

      lines[terminalIndex] = originalTerminal;
      const changedHeader = originalHeader.replace(
        '"model":"deepseek-chat"',
        '"model":"tampered-model"',
      );
      lines[0] = changedHeader;
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
      expect(() => history.transcript(lifecycle.childAgentId)).toThrow(
        "identity mismatches acceptance",
      );

      lines[0] = originalHeader;
      lines[1] =
        '{"schemaVersion":1,"type":"transcript_initialize","messages":[{"role":"assistant"}]}';
      await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");

      expect(() => history.transcript(lifecycle.childAgentId)).toThrow(
        "invalid agent transcript record",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
