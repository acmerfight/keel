import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  formatSessionGoalCompletedToolResult,
  sessionGoalSchema,
} from "../../src/core/session-goal.ts";
import {
  executeToolCall,
  type GoalCompletionCommandEvidence,
} from "../../src/tools/execution.ts";
import {
  openAICompatibleTools,
  toolCallFromParsedArguments,
} from "../../src/tools/registry.ts";

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("Session Goal Tool", () => {
  test(`Given a saved session goal has a completion command,
    When the goal schema parses it,
    Then Keel trims and preserves the command criterion`, () => {
    expect(
      sessionGoalSchema.parse({
        objective: "Ship the checkout fix",
        status: "active",
        completionCommand: " pnpm test ",
      }),
    ).toEqual({
      objective: "Ship the checkout fix",
      status: "active",
      completionCommand: "pnpm test",
    });
  });

  test(`Given a completed session goal already has sentence punctuation,
    When the tool result is formatted,
    Then Keel does not append a duplicate period`, () => {
    expect(
      formatSessionGoalCompletedToolResult({
        objective: "Finish the migration?",
        status: "completed",
      }),
    ).toBe("Session goal completed: Finish the migration?");
  });

  test(`Given provider tools are listed,
    When bash is disabled,
    Then update_goal is exposed as a narrow completion-proposal agent-state tool`, () => {
    // Given / When
    const tools = openAICompatibleTools(false);
    const updateGoal = tools.find(
      (tool) => tool.function.name === "update_goal",
    );

    // Then
    expect(updateGoal?.function.parameters).toMatchObject({
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["completed"],
        },
      },
      required: ["status"],
      additionalProperties: false,
    });
  });

  test(`Given update_goal receives completed for an active goal without a completion command,
    When the builtin tool executes,
    Then it rejects model-owned completion without mutating goal state`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-update-goal-"));
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "completed",
    });

    try {
      if (toolCall === null) {
        throw new Error("expected valid update_goal call");
      }

      // When
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal: freshSignal(),
        allowBash: false,
        sessionGoal: {
          objective: "Finish the durable checkout goal",
          status: "active",
        },
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "Tool failed: update_goal failed: no completion command is set",
        ),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives completed with fresh successful command evidence,
    When the builtin tool executes,
    Then it returns the completed deterministic goal state`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-evidence-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "completed",
    });

    try {
      if (toolCall === null) {
        throw new Error("expected valid update_goal call");
      }

      // When
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal: freshSignal(),
        allowBash: false,
        sessionGoal: {
          objective: "Finish the durable checkout goal",
          status: "active",
          completionCommand: "pnpm test",
        },
        goalCompletionCommandEvidence: {
          command: "pnpm test",
          cwd: workspace,
          exitCode: 0,
          observedMutationSequence: 0,
        },
      });

      // Then
      expect(execution).toMatchObject({
        ok: true,
        content: "Session goal completed: Finish the durable checkout goal.",
        sessionGoalUpdate: {
          objective: "Finish the durable checkout goal",
          status: "completed",
          completionCommand: "pnpm test",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "no command evidence",
      evidence: () => undefined,
      expected:
        "Tool failed: update_goal failed: completion command has not run",
    },
    {
      name: "different command evidence",
      evidence: (workspace: string): GoalCompletionCommandEvidence => ({
        command: "pnpm lint",
        cwd: workspace,
        exitCode: 0,
        observedMutationSequence: 0,
      }),
      expected:
        "Tool failed: update_goal failed: latest command evidence does not match",
    },
    {
      name: "different cwd evidence",
      evidence: (workspace: string): GoalCompletionCommandEvidence => ({
        command: "pnpm test",
        cwd: join(workspace, "other"),
        exitCode: 0,
        observedMutationSequence: 0,
      }),
      expected:
        "Tool failed: update_goal failed: latest command evidence came from a different working directory",
    },
  ])(`Given update_goal receives completed with $name,
    When the builtin tool executes,
    Then it keeps the goal active and returns the evidence gate reason`, async ({
    evidence,
    expected,
  }) => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-rejected-evidence-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "completed",
    });
    const goalCompletionCommandEvidence = evidence(workspace);

    try {
      if (toolCall === null) {
        throw new Error("expected valid update_goal call");
      }

      // When
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal: freshSignal(),
        allowBash: goalCompletionCommandEvidence === undefined,
        sessionGoal: {
          objective: "Finish the durable checkout goal",
          status: "active",
          completionCommand: "pnpm test",
        },
        ...(goalCompletionCommandEvidence !== undefined
          ? { goalCompletionCommandEvidence }
          : {}),
        workspaceMutationSequence: 0,
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(expected),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives completed without evidence while bash is disabled,
    When the builtin tool executes,
    Then it tells the model that automatic verification is unavailable`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-disabled-bash-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "completed",
    });

    try {
      if (toolCall === null) {
        throw new Error("expected valid update_goal call");
      }

      // When
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal: freshSignal(),
        allowBash: false,
        sessionGoal: {
          objective: "Finish the durable checkout goal",
          status: "active",
          completionCommand: "pnpm test",
        },
        workspaceMutationSequence: 0,
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          'Recovery: Bash is disabled in this run, so the agent cannot run "pnpm test". Ask the user to resume with --bash-policy ask or --bash-policy trusted, or to use /goal complete after checking it manually.',
        ),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives completed with failed command evidence,
    When the builtin tool executes,
    Then it keeps the goal active and returns the failed evidence reason`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-failed-evidence-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "completed",
    });

    try {
      if (toolCall === null) {
        throw new Error("expected valid update_goal call");
      }

      // When
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal: freshSignal(),
        allowBash: false,
        sessionGoal: {
          objective: "Finish the durable checkout goal",
          status: "active",
          completionCommand: "pnpm test",
        },
        goalCompletionCommandEvidence: {
          command: "pnpm test",
          cwd: workspace,
          exitCode: 1,
          observedMutationSequence: 0,
        },
        workspaceMutationSequence: 0,
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "Tool failed: update_goal failed: completion command exited with code 1.",
        ),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives completed with unknown command exit code,
    When the builtin tool executes,
    Then it keeps the goal active and returns the unknown exit reason`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-unknown-exit-evidence-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "completed",
    });

    try {
      if (toolCall === null) {
        throw new Error("expected valid update_goal call");
      }

      // When
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal: freshSignal(),
        allowBash: false,
        sessionGoal: {
          objective: "Finish the durable checkout goal",
          status: "active",
          completionCommand: "pnpm test",
        },
        goalCompletionCommandEvidence: {
          command: "pnpm test",
          cwd: workspace,
          exitCode: null,
          observedMutationSequence: 0,
        },
        workspaceMutationSequence: 0,
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "Tool failed: update_goal failed: completion command exited with code unknown.",
        ),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives completed with stale command evidence,
    When the builtin tool executes,
    Then it keeps the goal active and asks for a fresh command run`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-stale-evidence-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "completed",
    });

    try {
      if (toolCall === null) {
        throw new Error("expected valid update_goal call");
      }

      // When
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal: freshSignal(),
        allowBash: false,
        sessionGoal: {
          objective: "Finish the durable checkout goal",
          status: "active",
          completionCommand: "pnpm test",
        },
        goalCompletionCommandEvidence: {
          command: "pnpm test",
          cwd: workspace,
          exitCode: 0,
          observedMutationSequence: 0,
        },
        workspaceMutationSequence: 1,
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "Tool failed: update_goal failed: completion command evidence is stale",
        ),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no active session goal exists,
    When update_goal executes,
    Then it fails without mutating session goal state`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-update-goal-none-"));
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "completed",
    });

    try {
      if (toolCall === null) {
        throw new Error("expected valid update_goal call");
      }

      // When
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal: freshSignal(),
        allowBash: false,
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "Tool failed: update_goal failed: no active session goal is set.",
        ),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives an unsupported state,
    When provider arguments are parsed,
    Then the invalid arguments become a recoverable update_goal failure`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-invalid-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_bad", "update_goal", {
      status: "blocked",
    });

    try {
      if (toolCall === null) {
        throw new Error("expected recoverable invalid update_goal call");
      }

      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        allowBash: false,
        toolCall,
      });

      // Then
      expect(toolCall).toMatchObject({
        tool: "update_goal",
        invalidArguments: { status: "blocked" },
        validationError: expect.any(String),
      });
      expect(result).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "Tool failed: update_goal failed: invalid arguments",
        ),
      });
      expect(result.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
