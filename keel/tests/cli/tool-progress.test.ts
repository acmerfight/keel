import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import {
  formatCostReport,
  formatLiveSessionGoalStatus,
  type InteractiveTranscriptEvent,
  printAgentEvents,
  printInteractiveTerminalAgentEvents,
  printStableInteractiveAgentEvents,
} from "../../src/cli/output.ts";
import { runCli } from "../../src/testing/cli-harness.ts";

describe("CLI Tool Progress", () => {
  test(`Given cost reports encode their budget state,
    When the CLI formats the cost line,
    Then each budget variant is rendered from the discriminant`, () => {
    expect(
      formatCostReport({
        spentUsd: 1.25,
        budget: { kind: "unbounded" },
      }),
    ).toBe("Cost: $1.2500\n");
    expect(
      formatCostReport({
        spentUsd: 1.25,
        budget: { kind: "within_budget", maxUsd: 2 },
      }),
    ).toBe("Cost: $1.2500 (budget $2.0000)\n");
    expect(
      formatCostReport({
        spentUsd: 2,
        budget: { kind: "budget_limited", maxUsd: 2, overshootUsd: 0 },
      }),
    ).toBe(
      "Cost: $2.0000 (remaining best-effort budget cannot admit another provider request)\n",
    );
    expect(
      formatCostReport({
        spentUsd: 2.5,
        budget: { kind: "budget_limited", maxUsd: 2, overshootUsd: 0.5 },
      }),
    ).toBe("Cost: $2.5000 (best-effort budget $2.0000 exceeded by $0.5000)\n");
  });

  test(`Given live Goal status may be absent or contain long model-owned reasons,
    When it is formatted for the bounded TUI region,
    Then missing state clears the region and rendered state stays single-line safe`, () => {
    expect(formatLiveSessionGoalStatus(undefined)).toBeNull();
    expect(
      formatLiveSessionGoalStatus({
        objective: "Inspect checkout",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        completion: {
          kind: "assertion",
          assertion: "The checkout is understood",
        },
      }),
    ).toBe(
      "active - Inspect checkout; criterion(assertion): The checkout is understood",
    );
    expect(
      formatLiveSessionGoalStatus({
        objective: "Inspect checkout",
        status: "active",
        budget: {},
        usage: { turns: 1, tokens: 20, activeTimeMs: 50 },
        completion: {
          kind: "assertion",
          assertion: "The checkout is understood",
        },
        latestRuntimeOutcome: {
          kind: "progress_observed",
          reason: "Fresh evidence was recorded.",
        },
      }),
    ).toBe(
      "active - Inspect checkout; criterion(assertion): The checkout is understood; outcome: progress observed - Fresh evidence was recorded.",
    );
    const status = formatLiveSessionGoalStatus({
      objective: "Inspect\ncheckout",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      completion: {
        kind: "assertion",
        assertion: "x".repeat(400),
      },
    });
    expect(status).toContain("active - Inspect\\ncheckout");
    expect(status).toHaveLength(243);
    expect(status?.endsWith("...")).toBe(true);
  });

  test(`Given a workspace file contains text to replace,
    When user runs the CLI and the agent edits the file,
    Then the user sees the running tool call without polluting the final answer`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");

    try {
      // When
      const result = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(result.stdout).toBe("Edited note.txt\n");
      expect(result.stderr).toBe(
        "Tool: read note.txt\nTool: edit note.txt\nWarning: change applied; undo checkpoint unavailable for this task.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call path embeds a newline that forges a progress line,
    When user runs the CLI,
    Then each progress record stays on one line with the newline made visible`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const forgedPath = "note.txt\nTool: edit forged.txt";

    try {
      // When
      const result = await runCli([`replace old with new in ${forgedPath}`], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      const escapedLabel = "read note.txt\\nTool: edit forged.txt";
      expect(result.stderr).toBe(
        `Tool: ${escapedLabel}\nTool failed: ${escapedLabel}\n`,
      );
      expect(result.stderr).not.toContain("\nTool: edit forged.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call path embeds a terminal control sequence,
    When user runs the CLI,
    Then the control character is printed as a visible escape instead of executing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    const clearScreenPath = "\u001b[2Jnote.txt";

    try {
      // When
      const result = await runCli(
        [`replace old with new in ${clearScreenPath}`],
        {
          cwd: workspace,
          env: { KEEL_PROVIDER: "fake" },
        },
      );

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("\u001b");
      expect(result.stderr).toContain("Tool: read \\x1b[2Jnote.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call argument is very long,
    When user runs the CLI,
    Then the progress line is truncated to a readable length`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    const longPath = `${"a".repeat(300)}.txt`;

    try {
      // When
      const result = await runCli([`replace old with new in ${longPath}`], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      const lines = result.stderr.split("\n").filter((line) => line !== "");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(200);
      }
      expect(result.stderr).toContain("...");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call path literally ends with the failure marker,
    When user runs the CLI,
    Then start lines and failure lines stay distinguishable by their prefix`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    const spoofedPath = "note.txt (failed)";

    try {
      // When
      const result = await runCli([`replace old with new in ${spoofedPath}`], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      const lines = result.stderr.split("\n").filter((line) => line !== "");
      expect(lines[0]).toBe("Tool: read note.txt (failed)");
      expect(lines[0]).not.toMatch(/^Tool failed: /);
      expect(lines[1]).toBe("Tool failed: read note.txt (failed)");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit targets text that does not exist,
    When user runs the CLI,
    Then the user sees the tool call marked as failed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-progress-"));
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");

    try {
      // When
      const result = await runCli(["replace missing with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello world\n",
      );
      expect(result.stderr).toBe(
        "Tool: read note.txt\nTool: edit note.txt\nTool failed: edit note.txt\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an agent updates visible task progress,
    When classic CLI output prints agent events,
    Then stderr shows the deterministic task summary`, async () => {
    // Given
    async function* events(): AsyncIterable<AgentEvent> {
      yield {
        type: "task_progress_updated",
        messageOrdinal: 2,
        taskProgress: {
          tasks: [{ step: "Inspect", status: "in_progress" }],
        },
      };
      yield {
        type: "end",
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        },
        turns: 1,
        stopReason: "completed",
      };
    }
    let stderr = "";

    // When
    await printAgentEvents(events(), {
      writeStdout() {},
      writeStderr(text) {
        stderr += text;
      },
    });

    // Then
    expect(stderr).toBe("Task progress: 0/1 completed; current: Inspect\n");
  });

  test(`Given an agent updates visible task progress,
    When stable interactive output prints agent events,
    Then the status line shows the deterministic task summary`, async () => {
    // Given
    async function* events(): AsyncIterable<AgentEvent> {
      yield {
        type: "task_progress_updated",
        messageOrdinal: 2,
        taskProgress: {
          tasks: [{ step: "Verify", status: "completed" }],
        },
      };
    }
    const statusLines: string[] = [];

    // When
    await printStableInteractiveAgentEvents(events(), {
      writeStdout() {},
      writeAssistantHeader() {},
      writeStatusLine(text) {
        statusLines.push(text);
      },
    });

    // Then
    expect(statusLines).toEqual(["Task progress: 1/1 completed"]);
  });

  test(`Given an agent saves project memory through a tool,
    When classic CLI output prints agent events,
    Then stderr includes the stable memory ID and project scope`, async () => {
    // Given
    async function* events(): AsyncIterable<AgentEvent> {
      yield {
        type: "tool_end",
        toolCall: {
          id: "memory_add_1",
          tool: "memory_add",
          text: "release tags use a v prefix",
        },
        ok: true,
        memoryOperation: {
          operation: "add",
          id: "mem_release",
          scope: { kind: "project", id: "project_release" },
          outcome: "saved",
        },
      };
    }
    let stderr = "";

    // When
    await printAgentEvents(events(), {
      writeStdout() {},
      writeStderr(text) {
        stderr += text;
      },
    });

    // Then
    expect(stderr).toBe(
      "Saved project memory mem_release for project_release.\n",
    );
  });

  test(`Given an agent forgets project memory through a tool,
    When stable interactive output prints agent events,
    Then the status line includes the stable memory ID and project scope`, async () => {
    // Given
    async function* events(): AsyncIterable<AgentEvent> {
      yield {
        type: "tool_end",
        toolCall: {
          id: "memory_forget_1",
          tool: "memory_forget",
          memoryId: "mem_release",
        },
        ok: true,
        memoryOperation: {
          operation: "forget",
          id: "mem_release",
          scope: { kind: "project", id: "project_release" },
          outcome: "forgotten",
        },
      };
    }
    const statusLines: string[] = [];

    // When
    await printStableInteractiveAgentEvents(events(), {
      writeStdout() {},
      writeAssistantHeader() {},
      writeStatusLine(text) {
        statusLines.push(text);
      },
    });

    // Then
    expect(statusLines).toEqual([
      "Forgot project memory mem_release for project_release.",
    ]);
  });

  test(`Given reviewed memory is rejected or remains pending,
    When classic CLI output prints the proposal operations,
    Then each inactive outcome is reported without implying activation`, async () => {
    async function* events(): AsyncIterable<AgentEvent> {
      for (const [candidateId, outcome] of [
        ["cand_rejected", "rejected"],
        ["cand_pending", "pending"],
      ] as const) {
        yield {
          type: "tool_end",
          toolCall: {
            id: `memory_propose_${outcome}`,
            tool: "memory_propose",
            kind: "project_context",
            statement: "Release validation uses pnpm test:coverage.",
            why: "Useful in later release work.",
            sourceQuote: "pnpm test:coverage",
            conflictMemoryIds: [],
          },
          ok: true,
          memoryOperation: {
            operation: "propose",
            candidateId,
            memoryId: null,
            scope: { kind: "project", id: "project_release" },
            outcome,
          },
        };
      }
    }
    let stderr = "";

    await printAgentEvents(events(), {
      writeStdout() {},
      writeStderr(text) {
        stderr += text;
      },
    });

    expect(stderr).toBe(
      [
        "Rejected project-memory candidate cand_rejected for project_release.",
        "Project-memory candidate cand_pending remains pending for project_release. Review it with: keel memory candidates show cand_pending; approve with: keel memory candidates approve cand_pending (add --keep or --supersede <memory-id> when required).",
        "",
      ].join("\n"),
    );
  });

  test(`Given an agent updates the visible session goal,
    When classic CLI output prints agent events,
    Then stderr shows the deterministic goal summary`, async () => {
    // Given
    async function* events(): AsyncIterable<AgentEvent> {
      yield {
        type: "session_goal_updated",
        messageOrdinal: 2,
        goal: {
          objective: "Finish checkout",
          status: "completed",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          completionEvidence: { kind: "user_override" },
          latestRuntimeOutcome: {
            kind: "completed",
            reason: "The user explicitly completed the goal.",
          },
        },
      };
    }
    let stderr = "";

    // When
    await printAgentEvents(events(), {
      writeStdout() {},
      writeStderr(text) {
        stderr += text;
      },
    });

    // Then
    expect(stderr).toBe(
      "Session goal: completed - Finish checkout; criterion: missing\n" +
        "Session goal outcome: completed - The user explicitly completed the goal.\n" +
        "Session goal evidence: user explicitly completed the goal with /goal complete\n",
    );
  });

  test(`Given an agent updates a visible session goal without completion evidence,
    When classic CLI output prints agent events,
    Then stderr omits the evidence line`, async () => {
    // Given
    async function* events(): AsyncIterable<AgentEvent> {
      yield {
        type: "session_goal_updated",
        messageOrdinal: 2,
        goal: {
          objective: "Continue checkout",
          status: "active",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          completion: {
            kind: "command",
            command: "pnpm test",
          },
        },
      };
    }
    let stderr = "";

    // When
    await printAgentEvents(events(), {
      writeStdout() {},
      writeStderr(text) {
        stderr += text;
      },
    });

    // Then
    expect(stderr).toBe(
      "Session goal: active - Continue checkout; criterion(command): pnpm test\n",
    );
  });

  test(`Given an agent updates the visible session goal,
    When stable interactive output prints agent events,
    Then the status line shows the deterministic goal summary`, async () => {
    // Given
    async function* events(): AsyncIterable<AgentEvent> {
      yield {
        type: "session_goal_updated",
        messageOrdinal: 2,
        goal: {
          objective: "Finish checkout",
          status: "completed",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          completionEvidence: { kind: "user_override" },
          latestRuntimeOutcome: {
            kind: "completed",
            reason: "The user explicitly completed the goal.",
          },
        },
      };
    }
    const statusLines: string[] = [];

    // When
    await printStableInteractiveAgentEvents(events(), {
      writeStdout() {},
      writeAssistantHeader() {},
      writeStatusLine(text) {
        statusLines.push(text);
      },
    });

    // Then
    expect(statusLines).toEqual([
      "Session goal: completed - Finish checkout; criterion: missing",
      "Session goal outcome: completed - The user explicitly completed the goal.",
      "Session goal evidence: user explicitly completed the goal with /goal complete",
    ]);
  });

  test(`Given an agent updates a visible session goal without completion evidence,
    When stable interactive output prints agent events,
    Then the status lines omit the evidence line`, async () => {
    // Given
    async function* events(): AsyncIterable<AgentEvent> {
      yield {
        type: "session_goal_updated",
        messageOrdinal: 2,
        goal: {
          objective: "Continue checkout",
          status: "active",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          completion: {
            kind: "command",
            command: "pnpm test",
          },
        },
      };
    }
    const statusLines: string[] = [];

    // When
    await printStableInteractiveAgentEvents(events(), {
      writeStdout() {},
      writeAssistantHeader() {},
      writeStatusLine(text) {
        statusLines.push(text);
      },
    });

    // Then
    expect(statusLines).toEqual([
      "Session goal: active - Continue checkout; criterion(command): pnpm test",
    ]);
  });

  test(`Given stable interactive events move through tools, Goal updates, and text,
    When the stable event printer observes the stream,
    Then it owns only transient activity while Goal updates remain transcript output`, async () => {
    // Given
    async function* events(): AsyncIterable<AgentEvent> {
      const toolCall = {
        id: "live_read",
        tool: "read",
        path: "README.md",
      } as const;
      yield {
        type: "context_compacted",
        reason: "proactive",
        historyCompacted: true,
        artifacts: [],
        beforeMessageCount: 8,
        afterMessageCount: 3,
        beforeEstimatedTokens: 1_000,
        afterEstimatedTokens: 400,
        toolOutputsCompacted: 0,
        staleToolOutputsCompacted: 0,
        currentToolOutputsCompacted: 0,
        toolOutputCharsBefore: 0,
        toolOutputCharsAfter: 0,
        toolOutputEstimatedTokensBefore: 0,
        toolOutputEstimatedTokensAfter: 0,
      };
      yield { type: "tool_start", toolCall };
      yield { type: "tool_end", toolCall, ok: true };
      yield { type: "tool_end", toolCall, ok: false };
      yield {
        type: "session_goal_updated",
        messageOrdinal: 2,
        goal: {
          objective: "Ship live status",
          status: "active",
          budget: {},
          usage: { turns: 1, tokens: 20, activeTimeMs: 50 },
          completion: {
            kind: "assertion",
            assertion: "Live status is visible",
          },
          latestRuntimeOutcome: {
            kind: "progress_observed",
            reason: "The status boundary rendered fresh progress.",
          },
        },
      };
      yield { type: "text", text: "Done" };
      yield { type: "text", text: "." };
      yield {
        type: "end",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          uncachedInputTokens: 10,
          outputTokens: 1,
        },
        turns: 1,
        stopReason: "completed",
      };
    }
    const activities: Array<string | null> = [];

    // When
    await printStableInteractiveAgentEvents(events(), {
      writeStdout() {},
      writeAssistantHeader() {},
      writeStatusLine() {},
      setActivityStatus(text) {
        activities.push(text);
      },
    });

    // Then
    expect(activities).toEqual([
      "Thinking",
      "Context compacted",
      "Tool: read README.md",
      "Thinking",
      "Tool failed: read README.md",
      "Responding",
      "Responding",
      null,
    ]);
  });

  test(`Given the agent emits every interactive event family,
    When the semantic terminal adapter consumes the stream,
    Then it produces one typed audit trail and settles unfinished tools`, async () => {
    // Given
    const successfulRead = {
      id: "read-success",
      tool: "read",
      path: "success.md",
    } as const;
    const rememberedRead = {
      id: "read-memory",
      tool: "read",
      path: "memory.md",
    } as const;
    const failedRead = {
      id: "read-failure",
      tool: "read",
      path: "failure.md",
    } as const;
    const interruptedBash = {
      id: "bash-interrupted",
      tool: "bash",
      command: "sleep 10",
    } as const;
    const endEvent = {
      type: "end",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        uncachedInputTokens: 10,
        outputTokens: 2,
      },
      turns: 2,
      stopReason: "completed",
    } as const satisfies AgentEvent;
    const sourceEvents = [
      { type: "text", text: "\u001banswer" },
      {
        type: "context_compacted",
        reason: "proactive",
        historyCompacted: true,
        artifacts: [],
        beforeMessageCount: 8,
        afterMessageCount: 3,
        beforeEstimatedTokens: 1_000,
        afterEstimatedTokens: 400,
        toolOutputsCompacted: 0,
        staleToolOutputsCompacted: 0,
        currentToolOutputsCompacted: 0,
        toolOutputCharsBefore: 0,
        toolOutputCharsAfter: 0,
        toolOutputEstimatedTokensBefore: 0,
        toolOutputEstimatedTokensAfter: 0,
      },
      {
        type: "provider_retry",
        provider: "deepseek",
        reason: "provider_network_error",
        attempt: 2,
        maxRetries: 3,
        delayMs: 125.4,
      },
      { type: "tool_start", toolCall: successfulRead },
      { type: "tool_end", toolCall: successfulRead, ok: true },
      { type: "tool_start", toolCall: rememberedRead },
      {
        type: "tool_end",
        toolCall: rememberedRead,
        ok: true,
        memoryOperation: {
          operation: "add",
          id: "mem-release",
          scope: { kind: "project", id: "project-release" },
          outcome: "saved",
        },
      },
      { type: "tool_start", toolCall: failedRead },
      { type: "tool_end", toolCall: failedRead, ok: false },
      { type: "tool_start", toolCall: interruptedBash },
      {
        type: "task_progress_updated",
        messageOrdinal: 2,
        taskProgress: {
          tasks: [{ step: "Inspect TUI", status: "in_progress" }],
        },
      },
      {
        type: "session_goal_updated",
        messageOrdinal: 2,
        goal: {
          objective: "Finish TUI",
          status: "completed",
          budget: {},
          usage: { turns: 1, tokens: 20, activeTimeMs: 50 },
          completionEvidence: { kind: "user_override" },
          latestRuntimeOutcome: {
            kind: "completed",
            reason: "The user explicitly completed the goal.",
          },
        },
      },
      {
        type: "session_goal_updated",
        messageOrdinal: 3,
        goal: {
          objective: "Continue TUI",
          status: "active",
          budget: {},
          usage: { turns: 1, tokens: 20, activeTimeMs: 50 },
          completion: {
            kind: "assertion",
            assertion: "The audit trail remains readable",
          },
        },
      },
      {
        type: "tool_output_artifact",
        status: "stored",
        ref: "artifact://tool-output/read-success",
        toolCallId: "read-success",
        toolName: "read",
        sourceStatus: "complete",
        omittedChars: 200,
      },
      {
        type: "tool_output_artifact",
        status: "failed",
        reason: "disk full",
        toolCallId: "read-failure",
        toolName: "read",
        omittedChars: 200,
      },
      { type: "undo_checkpoint", written: true },
      {
        type: "skill_activated",
        name: "repo:review",
        relativePath: ".agents/skills/review/SKILL.md",
        trigger: "model_selected",
      },
      endEvent,
    ] as const satisfies readonly AgentEvent[];
    async function* events(): AsyncIterable<AgentEvent> {
      yield* sourceEvents;
    }
    const activities: Array<string | null> = [];
    const transcriptEvents: InteractiveTranscriptEvent[] = [];

    // When
    const returnedEnd = await printInteractiveTerminalAgentEvents(events(), {
      renderAgentEvent(event) {
        transcriptEvents.push(event);
      },
      setActivityStatus(text) {
        activities.push(text);
      },
    });

    // Then
    expect(returnedEnd).toEqual(endEvent);
    expect(transcriptEvents).toEqual([
      { type: "assistant_delta", text: "\\x1banswer" },
      {
        type: "notice",
        tone: "info",
        text: "Context compacted: proactive (8 -> 3 messages, ~1000 -> ~400 tokens)",
      },
      {
        type: "notice",
        tone: "warning",
        text: "Provider retry: deepseek network error (attempt 2/3 in 125ms)",
      },
      {
        type: "tool_started",
        toolCallId: "read-success",
        label: "read success.md",
      },
      {
        type: "tool_succeeded",
        toolCallId: "read-success",
        label: "read success.md",
      },
      {
        type: "tool_started",
        toolCallId: "read-memory",
        label: "read memory.md",
      },
      {
        type: "tool_succeeded",
        toolCallId: "read-memory",
        label: "read memory.md",
      },
      {
        type: "notice",
        tone: "info",
        text: "Saved project memory mem-release for project-release.",
      },
      {
        type: "tool_started",
        toolCallId: "read-failure",
        label: "read failure.md",
      },
      {
        type: "tool_failed",
        toolCallId: "read-failure",
        label: "read failure.md",
      },
      {
        type: "tool_started",
        toolCallId: "bash-interrupted",
        label: "bash sleep 10",
      },
      {
        type: "notice",
        tone: "info",
        text: "Task progress: 0/1 completed; current: Inspect TUI",
      },
      {
        type: "notice",
        tone: "info",
        text: "Session goal: completed - Finish TUI; criterion: missing",
      },
      {
        type: "notice",
        tone: "info",
        text: "Session goal outcome: completed - The user explicitly completed the goal.",
      },
      {
        type: "notice",
        tone: "info",
        text: "Session goal evidence: user explicitly completed the goal with /goal complete",
      },
      {
        type: "notice",
        tone: "info",
        text: "Session goal: active - Continue TUI; criterion(assertion): The audit trail remains readable",
      },
      {
        type: "notice",
        tone: "info",
        text: "Tool output artifact: artifact://tool-output/read-success (keel artifacts show artifact://tool-output/read-success)",
      },
      {
        type: "notice",
        tone: "error",
        text: "Tool output artifact failed: disk full; output is lossy; rerun with narrower parameters if needed",
      },
      {
        type: "tool_interrupted",
        toolCallId: "bash-interrupted",
        label: "bash sleep 10",
      },
    ]);
    expect(activities).toEqual([
      "Thinking",
      "Responding",
      "Context compacted",
      "Waiting to retry provider",
      "Running read success.md",
      "Thinking",
      "Running read memory.md",
      "Thinking",
      "Running read failure.md",
      "Tool failed: read failure.md",
      "Running bash sleep 10",
      "Task progress updated",
      "Stored tool output artifact",
      "Tool output artifact failed",
      null,
    ]);
  });
});
