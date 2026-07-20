import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  formatSessionTaskProgressToolResult,
  type SessionTaskProgress,
  sessionTaskProgressesEqual,
} from "../../src/core/task-progress.ts";
import {
  executeToolCall,
  type ToolExecution,
  toolExecutionEffect,
} from "../../src/tools/execution.ts";
import {
  openAICompatibleTools,
  toolCallFromParsedArguments,
} from "../../src/tools/registry.ts";

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function taskProgressUpdate(
  execution: ToolExecution,
): SessionTaskProgress | undefined {
  if (!execution.ok) {
    return undefined;
  }
  return toolExecutionEffect(execution, "task_progress")?.taskProgress;
}

describe("Task Progress Tool", () => {
  test(`Given provider tools are listed,
    When bash is disabled,
    Then update_plan is exposed as an agent-state tool with deterministic statuses`, () => {
    // Given / When
    const tools = openAICompatibleTools({ kind: "auto" });
    const updatePlan = tools.find(
      (tool) => tool.function.name === "update_plan",
    );

    // Then
    expect(updatePlan?.function.parameters).toMatchObject({
      type: "object",
      properties: {
        plan: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
      additionalProperties: false,
    });
  });

  test(`Given update_plan receives a replacement task list,
    When the builtin tool executes,
    Then it returns the new deterministic task progress state`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-update-plan-"));
    const toolCall = toolCallFromParsedArguments("plan_1", "update_plan", {
      plan: [
        { step: "Inspect failing test", status: "completed" },
        { step: "Patch implementation", status: "in_progress" },
        { step: "Run verification", status: "pending" },
      ],
    });

    try {
      if (toolCall === null) {
        throw new Error("expected valid update_plan call");
      }

      // When
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal: freshSignal(),
        bash: { kind: "disabled" },
      });

      // Then
      expect(execution).toMatchObject({
        ok: true,
        content:
          "Task progress updated: 1/3 completed; current: Patch implementation.",
      });
      expect(taskProgressUpdate(execution)).toEqual({
        tasks: [
          { step: "Inspect failing test", status: "completed" },
          { step: "Patch implementation", status: "in_progress" },
          { step: "Run verification", status: "pending" },
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_plan receives invalid task states,
    When provider arguments are parsed,
    Then blank steps unknown fields and multiple in-progress tasks become recoverable tool failures`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-update-plan-invalid-"),
    );
    const invalidCalls = [
      toolCallFromParsedArguments("blank", "update_plan", {
        plan: [{ step: " ", status: "pending" }],
      }),
      toolCallFromParsedArguments("unknown", "update_plan", {
        plan: [{ step: "Do work", status: "pending", priority: "high" }],
      }),
      toolCallFromParsedArguments("two_active", "update_plan", {
        plan: [
          { step: "First", status: "in_progress" },
          { step: "Second", status: "in_progress" },
        ],
      }),
    ];

    try {
      for (const toolCall of invalidCalls) {
        if (toolCall === null) {
          throw new Error("expected recoverable invalid update_plan call");
        }

        // When
        const result = await executeToolCall({
          workspace,
          signal: freshSignal(),
          bash: { kind: "disabled" },
          toolCall,
        });

        // Then
        expect(toolCall).toMatchObject({
          tool: "update_plan",
          invalidArguments: expect.any(Object),
          validationError: expect.any(String),
        });
        expect(result).toMatchObject({
          ok: false,
          content: expect.stringContaining(
            "Tool failed: update_plan failed: invalid arguments",
          ),
        });
        expect(taskProgressUpdate(result)).toBeUndefined();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given update_plan receives non-object provider arguments,
    When provider arguments are parsed,
    Then the raw arguments are preserved in a recoverable tool failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-update-plan-array-"));
    const toolCall = toolCallFromParsedArguments("array", "update_plan", [
      { step: "Inspect request", status: "in_progress" },
    ]);

    try {
      if (toolCall === null) {
        throw new Error("expected recoverable invalid update_plan call");
      }

      // When
      const result = await executeToolCall({
        workspace,
        signal: freshSignal(),
        bash: { kind: "disabled" },
        toolCall,
      });

      // Then
      expect(toolCall).toMatchObject({
        tool: "update_plan",
        invalidArguments: {
          arguments: [{ step: "Inspect request", status: "in_progress" }],
        },
        validationError: expect.stringContaining("arguments"),
      });
      expect(result).toMatchObject({
        ok: false,
        content: expect.stringContaining(
          "Tool failed: update_plan failed: invalid arguments",
        ),
      });
      expect(taskProgressUpdate(result)).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given task progress is cleared or fully complete,
    When progress summaries are formatted,
    Then deterministic status text covers empty and no-current-task states`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-update-plan-empty-"));
    const clearCall = toolCallFromParsedArguments("clear", "update_plan", {
      plan: [],
    });
    const doneProgress = {
      tasks: [
        { step: "Inspect", status: "completed" as const },
        { step: "Verify", status: "completed" as const },
      ],
    };

    try {
      if (clearCall === null) {
        throw new Error("expected valid clear update_plan call");
      }

      // When
      const clearExecution = await executeToolCall({
        workspace,
        toolCall: clearCall,
        signal: freshSignal(),
        bash: { kind: "disabled" },
      });

      // Then
      expect(clearExecution).toMatchObject({
        ok: true,
        content: "Task progress cleared.",
      });
      expect(taskProgressUpdate(clearExecution)).toEqual({ tasks: [] });
      expect(formatSessionTaskProgressToolResult(doneProgress)).toBe(
        "Task progress updated: 2/2 completed.",
      );
      expect(
        formatSessionTaskProgressToolResult({
          tasks: [{ step: "Ship it!", status: "in_progress" }],
        }),
      ).toBe("Task progress updated: 0/1 completed; current: Ship it!");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given task progress states are compared,
    When list lengths or deterministic fields differ,
    Then equality reflects the concrete task list`, () => {
    expect(
      sessionTaskProgressesEqual(
        { tasks: [{ step: "Inspect", status: "pending" }] },
        { tasks: [] },
      ),
    ).toBe(false);
    expect(
      sessionTaskProgressesEqual(
        { tasks: [{ step: "Inspect", status: "pending" }] },
        { tasks: [{ step: "Inspect", status: "completed" }] },
      ),
    ).toBe(false);
    expect(
      sessionTaskProgressesEqual(
        { tasks: [{ step: "Inspect", status: "pending" }] },
        { tasks: [{ step: "Inspect", status: "pending" }] },
      ),
    ).toBe(true);
  });
});
