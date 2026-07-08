import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  activeSessionGoalSystemPrompt,
  formatSessionGoalBlockedToolResult,
  formatSessionGoalCompletedToolResult,
  formatSessionGoalSummary,
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
  test(`Given a saved session goal has a command completion criterion,
    When the goal schema parses it,
    Then Keel trims and preserves the explicit criterion contract`, () => {
    expect(
      sessionGoalSchema.parse({
        objective: "Ship the checkout fix",
        status: "active",
        criterionKind: "command",
        completionCriterion: " pnpm test ",
      }),
    ).toEqual({
      objective: "Ship the checkout fix",
      status: "active",
      criterionKind: "command",
      completionCriterion: "pnpm test",
    });
  });

  test(`Given a blocked session goal has a reason,
    When the goal schema parses it,
    Then Keel preserves the paused work boundary and normalizes the reason`, () => {
    expect(
      sessionGoalSchema.parse({
        objective: "Wait for credentials",
        status: "blocked",
        statusReason: " Need the API key\nfrom the user. ",
      }),
    ).toEqual({
      objective: "Wait for credentials",
      status: "blocked",
      statusReason: "Need the API key from the user.",
    });
    expect(
      sessionGoalSchema.safeParse({
        objective: "Wait for credentials",
        status: "blocked",
      }).success,
    ).toBe(false);
    expect(
      sessionGoalSchema.safeParse({
        objective: "Wait for credentials",
        status: "active",
        statusReason: "Need the API key from the user.",
      }).success,
    ).toBe(false);
  });

  test(`Given a saved session goal has only one completion criterion field,
    When the goal schema parses it,
    Then Keel rejects the incomplete criterion contract`, () => {
    expect(
      sessionGoalSchema.safeParse({
        objective: "Ship the checkout fix",
        status: "active",
        criterionKind: "command",
      }).success,
    ).toBe(false);
    expect(
      sessionGoalSchema.safeParse({
        objective: "Ship the checkout fix",
        status: "active",
        completionCriterion: "pnpm test",
      }).success,
    ).toBe(false);
  });

  test(`Given an active goal has an assertion completion criterion,
    When Keel builds the provider system prompt,
    Then it exposes the criterion without allowing model-owned completion`, () => {
    const prompt = activeSessionGoalSystemPrompt(
      {
        objective: "Publish release notes",
        status: "active",
        criterionKind: "assertion",
        completionCriterion: "Release notes cover every changed command.",
      },
      { bashToolVisible: true },
    );

    if (prompt === null) {
      throw new Error("expected active goal prompt");
    }
    expect(prompt).toContain(
      "Completion criterion (assertion): Release notes cover every changed command.",
    );
    expect(prompt).toContain(
      "Assertion criteria cannot be completed by the acting model yet.",
    );
    expect(prompt).not.toContain(
      "Before proposing completion, run the command completion criterion",
    );
  });

  test(`Given a paused or blocked goal exists,
    When Keel builds the provider system prompt,
    Then it does not inject that goal as active work`, () => {
    expect(
      activeSessionGoalSystemPrompt(
        {
          objective: "Paused objective",
          status: "paused",
        },
        { bashToolVisible: true },
      ),
    ).toBeNull();
    expect(
      activeSessionGoalSystemPrompt(
        {
          objective: "Blocked objective",
          status: "blocked",
          statusReason: "Need credentials from the user.",
        },
        { bashToolVisible: true },
      ),
    ).toBeNull();
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

  test(`Given a blocked session goal already has sentence punctuation,
    When the tool result is formatted,
    Then Keel reports the blocker reason without duplicating punctuation`, () => {
    expect(
      formatSessionGoalBlockedToolResult({
        objective: "Finish the migration?",
        status: "blocked",
        statusReason: "Need production credentials.",
      }),
    ).toBe(
      "Session goal blocked: Finish the migration? Reason: Need production credentials.",
    );
    expect(() =>
      formatSessionGoalBlockedToolResult({
        objective: "Finish the migration",
        status: "blocked",
      }),
    ).toThrow("Blocked session goal requires a reason.");
  });

  test(`Given session goals have and omit blocked reasons,
    When summaries are formatted,
    Then Keel only includes the reason for blocked goals that carry one`, () => {
    expect(
      formatSessionGoalSummary({
        objective: "Continue active work",
        status: "active",
      }),
    ).toBe("active - Continue active work; criterion: missing");
    expect(
      formatSessionGoalSummary({
        objective: "Wait for credentials",
        status: "blocked",
        statusReason: "Need credentials.",
      }),
    ).toBe(
      "blocked - Wait for credentials; criterion: missing; reason: Need credentials.",
    );
  });

  test(`Given provider tools are listed,
    When bash is disabled,
    Then update_goal is exposed as a narrow lifecycle-proposal agent-state tool`, () => {
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
          enum: ["completed", "blocked"],
        },
        reason: {
          type: "string",
        },
      },
      required: ["status"],
      additionalProperties: false,
    });
  });

  test(`Given update_goal receives blocked for an active goal,
    When the builtin tool executes,
    Then it persists a blocked goal with the model-provided reason`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-blocked-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "blocked",
      reason: " Need an API key\nfrom the user. ",
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
      });

      // Then
      expect(execution).toMatchObject({
        ok: true,
        content:
          "Session goal blocked: Finish the durable checkout goal. Reason: Need an API key from the user.",
        sessionGoalUpdate: {
          objective: "Finish the durable checkout goal",
          status: "blocked",
          statusReason: "Need an API key from the user.",
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives blocked without a reason,
    When the builtin tool validates the provider arguments,
    Then it returns a recoverable invalid-arguments failure`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-blocked-missing-reason-"),
    );

    try {
      // When
      const execution = await executeToolCall({
        workspace,
        toolCall: {
          id: "goal_1",
          tool: "update_goal",
          status: "blocked",
        },
        signal: freshSignal(),
        allowBash: false,
        sessionGoal: {
          objective: "Finish the durable checkout goal",
          status: "active",
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "reason: reason is required when status is blocked",
        ),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives blocked for an active goal without a criterion,
    When the builtin tool executes,
    Then it preserves the criterion-less blocked goal state`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-blocked-no-criterion-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "blocked",
      reason: "Need user input.",
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
        ok: true,
        sessionGoalUpdate: {
          objective: "Finish the durable checkout goal",
          status: "blocked",
          statusReason: "Need user input.",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives completed with a blocked-only reason,
    When the builtin tool validates the provider arguments,
    Then it returns a recoverable invalid-arguments failure`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-completed-reason-"),
    );
    const toolCall = toolCallFromParsedArguments("goal_1", "update_goal", {
      status: "completed",
      reason: "not allowed for completed",
    });

    try {
      if (toolCall === null) {
        throw new Error("expected recoverable invalid update_goal call");
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "reason: reason is only valid when status is blocked",
        ),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives completed for an active goal without a completion criterion,
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
          "Tool failed: update_goal failed: no completion criterion is set",
        ),
      });
      expect(execution.sessionGoalUpdate).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_goal receives completed for an active assertion-criterion goal,
    When the builtin tool executes before assertion evaluation exists,
    Then it rejects model-owned completion without mutating goal state`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-goal-assertion-"),
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
          objective: "Publish the migration notes",
          status: "active",
          criterionKind: "assertion",
          completionCriterion:
            "The release notes explain every changed command.",
        },
      });

      // Then
      expect(execution).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "Tool failed: update_goal failed: assertion completion criteria are not supported yet",
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
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
        "Tool failed: update_goal failed: command completion criterion has not run",
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
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
          "Tool failed: update_goal failed: command completion criterion exited with code 1.",
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
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
          "Tool failed: update_goal failed: command completion criterion exited with code unknown.",
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
          criterionKind: "command",
          completionCriterion: "pnpm test",
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
          "Tool failed: update_goal failed: command completion criterion evidence is stale",
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
