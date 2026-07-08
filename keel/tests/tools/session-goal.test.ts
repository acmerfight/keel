import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeToolCall } from "../../src/tools/execution.ts";
import {
  openAICompatibleTools,
  toolCallFromParsedArguments,
} from "../../src/tools/registry.ts";

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("Session Goal Tool", () => {
  test(`Given provider tools are listed,
    When bash is disabled,
    Then update_goal is exposed as a narrow completion-only agent-state tool`, () => {
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

  test(`Given update_goal receives completed for an active session goal,
    When the builtin tool executes,
    Then it returns the completed deterministic goal state`, async () => {
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
        ok: true,
        content: "Session goal completed: Finish the durable checkout goal.",
        sessionGoalUpdate: {
          objective: "Finish the durable checkout goal",
          status: "completed",
        },
      });
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
