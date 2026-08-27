import { describe, expect, test } from "vitest";
import {
  projectInteractiveActiveModelStatus,
  projectInteractiveActiveSkillsCommandOutput,
  projectInteractiveAgentControlResultCommandOutput,
  projectInteractiveAgentHistoryListCommandOutput,
  projectInteractiveAgentsRequiresSavedSessionCommandOutput,
  projectInteractiveCommandFailure,
  projectInteractiveCommandOutput,
  projectInteractiveCompactSkippedCommandOutput,
  projectInteractiveCurrentModelCommandOutput,
  projectInteractiveDiffCommandOutput,
  projectInteractiveForkCancelledCommandOutput,
  projectInteractiveForkCreatedCommandOutput,
  projectInteractiveForkPickerCommandOutput,
  projectInteractiveForkPointsCommandOutput,
  projectInteractiveForkRequiresNamedSessionCommandOutput,
  projectInteractiveHelpCommandOutput,
  projectInteractiveInvalidCommandOutput,
  projectInteractiveModelAlreadySetCommandOutput,
  projectInteractiveModelSwitchedCommandOutput,
  projectInteractiveModelUnknownContextCommandOutput,
  projectInteractiveRecoveryBlockedCommandOutput,
  projectInteractiveSessionAlreadyActiveCommandOutput,
  projectInteractiveSessionPickerPromptCommandOutput,
  projectInteractiveSessionSwitchCancelledCommandOutput,
  projectInteractiveSessionsRequiresSavedSessionCommandOutput,
  projectInteractiveSkillActivatedCommandOutput,
  projectInteractiveSkillDeactivatedCommandOutput,
  projectInteractiveSkillReloadedCommandOutput,
  projectInteractiveStatusCommandOutput,
  projectInteractiveTasksCommandOutput,
  projectInteractiveTitleCommandOutput,
  projectInteractiveTitleRequiresSavedSessionCommandOutput,
  projectInteractiveTitleSetCommandOutput,
  projectInteractiveUndoBlockedCommandOutput,
  projectInteractiveUndoCheckpointListCommandOutput,
  projectInteractiveUndoRestoredCommandOutput,
} from "../../../src/cli/interactive-session/command-output.ts";
import type { InteractiveCommandOutputEvent } from "../../../src/cli/interactive-session/display.ts";
import { emptySessionTaskProgress } from "../../../src/core/task-progress.ts";
import type { ActiveSkillStatus } from "../../../src/skills/model.ts";

function collect(events: readonly InteractiveCommandOutputEvent[]): {
  readonly stdout: string;
  readonly stderr: string;
} {
  let stdout = "";
  let stderr = "";
  for (const event of events) {
    switch (event.type) {
      case "stdout":
        stdout += event.text;
        break;
      case "stderr":
        stderr += event.text;
        break;
    }
  }
  return { stdout, stderr };
}

describe("Interactive command output projection", () => {
  test(`Given interactive command results,
    When they are projected for display,
    Then stdout and stderr events preserve the user-visible channels`, () => {
    // Given
    const activeSkill = {
      activation: {
        descriptorId: "repo-review",
        packageId: "repo",
        qualifiedName: "repo:review",
        scope: "repo",
        name: "review",
        relativePath: ".agents/skills/review/SKILL.md",
        resourcePaths: [],
        digest: "sha256:review",
        trigger: "user_explicit",
        args: "",
        contentSnapshot: "review instructions",
        activatedAt: "2026-08-27T00:00:00.000Z",
      },
      diskStatus: "current",
    } satisfies ActiveSkillStatus;
    const taskProgress = {
      tasks: [{ step: "Check command output", status: "in_progress" }],
    } satisfies ReturnType<typeof emptySessionTaskProgress>;
    const forkPoints = {
      sessionId: "demo",
      points: [
        {
          choice: 1,
          messageId: "msg-1",
          preview: "first request",
        },
      ],
    };
    const emptyAgentHistory = {
      sessionId: "demo",
      entries: () => [],
      runs: () => [],
      transcript: () => "",
      messages: () => [],
      pendingResultDeliveries: () => [],
      deliveredResult: () => {},
      persistence: {
        accepted: () => {
          throw new Error("not used by command output projection");
        },
        rejected: () => {},
      },
      reconcileBuiltInReadOnlyDelegate: () => ({ kind: "unknown" }),
    } satisfies Parameters<
      typeof projectInteractiveAgentHistoryListCommandOutput
    >[0];

    // When
    const projected = collect([
      ...projectInteractiveCommandOutput([
        { stream: "stdout", text: "plain out\n" },
        { stream: "stderr", text: "plain err\n" },
      ]),
      ...projectInteractiveCommandFailure(new Error("bad command")),
      ...projectInteractiveHelpCommandOutput(),
      ...projectInteractiveStatusCommandOutput({
        session: "demo",
        workspace: "/tmp/workspace",
        activeModel: projectInteractiveActiveModelStatus({
          resolved: null,
          configuredModelSelection: {
            providerId: "deepseek",
            model: "deepseek-chat",
          },
        }),
        executionPosture: "trusted",
        workflowSkills: [],
        messages: [],
        messageCount: 0,
        pendingInputCount: 0,
        taskProgress: emptySessionTaskProgress(),
        modelSwitchCount: 0,
        undoCheckpoints: [],
        recoveryActions: [],
      }),
      ...projectInteractiveAgentHistoryListCommandOutput(emptyAgentHistory),
      ...projectInteractiveAgentsRequiresSavedSessionCommandOutput(),
      ...projectInteractiveSessionsRequiresSavedSessionCommandOutput(),
      ...projectInteractiveSessionPickerPromptCommandOutput("Pick one:\n"),
      ...projectInteractiveSessionSwitchCancelledCommandOutput(),
      ...projectInteractiveSessionAlreadyActiveCommandOutput("demo"),
      ...projectInteractiveTitleCommandOutput(undefined),
      ...projectInteractiveTitleRequiresSavedSessionCommandOutput(),
      ...projectInteractiveTitleSetCommandOutput("Fix login"),
      ...projectInteractiveTasksCommandOutput(taskProgress),
      ...projectInteractiveDiffCommandOutput({
        kind: "failed",
        message: "diff failed",
      }),
      ...projectInteractiveInvalidCommandOutput(
        "Error: /status does not accept arguments.",
      ),
      ...projectInteractiveUndoCheckpointListCommandOutput([
        { restoredLabel: "src/app.ts" },
      ]),
      ...projectInteractiveUndoRestoredCommandOutput("src/app.ts"),
      ...projectInteractiveUndoBlockedCommandOutput("No undo checkpoints."),
      ...projectInteractiveCurrentModelCommandOutput({
        providerId: "deepseek",
        model: "deepseek-chat",
      }),
      ...projectInteractiveModelAlreadySetCommandOutput({
        providerId: "deepseek",
        model: "deepseek-chat",
      }),
      ...projectInteractiveModelUnknownContextCommandOutput({
        providerId: "local",
        model: "unknown",
      }),
      ...projectInteractiveModelSwitchedCommandOutput({
        providerId: "kimi",
        model: "kimi-k2",
      }),
      ...projectInteractiveActiveSkillsCommandOutput([activeSkill]),
      ...projectInteractiveSkillActivatedCommandOutput("repo:review"),
      ...projectInteractiveSkillDeactivatedCommandOutput("repo:review"),
      ...projectInteractiveSkillReloadedCommandOutput("repo:review"),
      ...projectInteractiveForkRequiresNamedSessionCommandOutput("/fork"),
      ...projectInteractiveForkPointsCommandOutput(forkPoints),
      ...projectInteractiveForkPickerCommandOutput(forkPoints),
      ...projectInteractiveForkCancelledCommandOutput(),
      ...projectInteractiveForkCreatedCommandOutput("Fork created.\n"),
      ...projectInteractiveCompactSkippedCommandOutput(),
      ...projectInteractiveAgentControlResultCommandOutput({
        ok: false,
        content: "child unavailable\n",
      }),
      ...projectInteractiveRecoveryBlockedCommandOutput("task-1"),
    ]);

    // Then
    expect(projected.stdout).toContain("plain out\n");
    expect(projected.stdout).toContain("Workflow:");
    expect(projected.stdout).toContain("session: demo");
    expect(projected.stdout).toContain("Agents for session: demo");
    expect(projected.stdout).toContain("Pick one:");
    expect(projected.stdout).toContain("Session switch cancelled.");
    expect(projected.stdout).toContain("Session already active: demo");
    expect(projected.stdout).toContain("Session title: (not set)");
    expect(projected.stdout).toContain("Session title set to: Fix login");
    expect(projected.stdout).toContain("1. [in_progress] Check command output");
    expect(projected.stdout).toContain("Undo checkpoints:");
    expect(projected.stdout).toContain("Restored src/app.ts");
    expect(projected.stdout).toContain("Current model: deepseek/deepseek-chat");
    expect(projected.stdout).toContain(
      "Model already set to deepseek/deepseek-chat",
    );
    expect(projected.stdout).toContain("Model switched to kimi/kimi-k2");
    expect(projected.stdout).toContain("Active workflow skills:");
    expect(projected.stdout).toContain("Activated workflow skill repo:review.");
    expect(projected.stdout).toContain(
      "Deactivated workflow skill repo:review.",
    );
    expect(projected.stdout).toContain("Reloaded workflow skill repo:review.");
    expect(projected.stdout).toContain('Fork points for session "demo":');
    expect(projected.stdout).toContain("Select fork point [0-1]");
    expect(projected.stdout).toContain("Fork cancelled.");
    expect(projected.stdout).toContain("Fork created.");
    expect(projected.stderr).toContain("plain err\n");
    expect(projected.stderr).toContain("bad command");
    expect(projected.stderr).toContain(
      "Error: /agents requires a saved interactive session.",
    );
    expect(projected.stderr).toContain(
      "Error: /sessions requires a saved interactive session.",
    );
    expect(projected.stderr).toContain(
      "Error: /title requires a saved session.",
    );
    expect(projected.stderr).toContain("diff failed");
    expect(projected.stderr).toContain(
      "Error: /status does not accept arguments.",
    );
    expect(projected.stderr).toContain("No undo checkpoints.");
    expect(projected.stderr).toContain(
      "Error: cannot switch to local/unknown because model metadata is unavailable",
    );
    expect(projected.stderr).toContain(
      "Error: /fork requires a saved session.",
    );
    expect(projected.stderr).toContain(
      "Context compaction skipped: no conversation history to compact.",
    );
    expect(projected.stderr).toContain("child unavailable");
    expect(projected.stderr).toContain(
      "Error: recovery_blocked for durable Task task-1; input remains queued.",
    );
  });
});
