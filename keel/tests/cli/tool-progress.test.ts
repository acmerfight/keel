import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import {
  formatLiveSessionGoalStatus,
  printAgentEvents,
  printStableInteractiveAgentEvents,
} from "../../src/cli/output.ts";
import { runCli } from "../../src/testing/cli-harness.ts";

describe("CLI Tool Progress", () => {
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
        criterionKind: "assertion",
        completionCriterion: "The checkout is understood",
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
        criterionKind: "assertion",
        completionCriterion: "The checkout is understood",
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
      criterionKind: "assertion",
      completionCriterion: "x".repeat(400),
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
      expect(result.stderr).toBe("Tool: read note.txt\nTool: edit note.txt\n");
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
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
          criterionKind: "assertion",
          completionCriterion: "Live status is visible",
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
});
