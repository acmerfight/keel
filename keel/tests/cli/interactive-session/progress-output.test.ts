import { describe, expect, test } from "vitest";
import type { ContextCompactionStats } from "../../../src/agent/context-compaction.ts";
import type { ToolOutputArtifactNotice } from "../../../src/agent/tool-output-artifacts.ts";
import { createInteractiveSessionDisplay } from "../../../src/cli/interactive-session/display.ts";
import {
  projectInteractiveCompactionAbortedNotice,
  projectInteractiveCompactionFailureNotice,
  projectInteractiveCompactionSkippedNotice,
  projectInteractiveCompactionSuccessNotice,
  projectInteractiveCostReport,
  projectInteractiveGoalLimitNotice,
  projectInteractiveSkillCatalogDegradationNotice,
  projectInteractiveSubagentProgressNotice,
  projectInteractiveUndoCheckpointWarningNotice,
} from "../../../src/cli/interactive-session/progress-output.ts";

const COMPACTION_STATS = {
  beforeMessageCount: 4,
  afterMessageCount: 2,
  beforeEstimatedTokens: 200,
  afterEstimatedTokens: 80,
  toolOutputsCompacted: 1,
  staleToolOutputsCompacted: 1,
  currentToolOutputsCompacted: 0,
  toolOutputCharsBefore: 1000,
  toolOutputCharsAfter: 120,
  toolOutputEstimatedTokensBefore: 250,
  toolOutputEstimatedTokensAfter: 30,
} satisfies ContextCompactionStats;

const STORED_ARTIFACT_NOTICE = {
  status: "stored",
  ref: "artifact-123",
  toolCallId: "call-123",
  toolName: "bash",
  sourceStatus: "complete",
  omittedChars: 1200,
} satisfies ToolOutputArtifactNotice;

describe("Interactive progress output projection", () => {
  test(`Given interactive progress notices,
    When they are projected and rendered through the display port,
    Then stdout, stderr, and cost report output stay on their visible channels`, () => {
    // Given
    let stdout = "";
    let stderr = "";
    const display = createInteractiveSessionDisplay({
      output: {
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      },
      printAgentEvents: async () => undefined,
    });

    // When
    display.renderProgressOutput([
      ...projectInteractiveCompactionAbortedNotice(),
      ...projectInteractiveCompactionSuccessNotice({
        stats: COMPACTION_STATS,
        reasonLabel: "manual",
        artifactNotices: [STORED_ARTIFACT_NOTICE],
      }),
      ...projectInteractiveCompactionFailureNotice("summary unavailable"),
      ...projectInteractiveCompactionSkippedNotice(),
      ...projectInteractiveCostReport({
        spentUsd: 0.25,
        budget: { kind: "within_budget", maxUsd: 1 },
      }),
      ...projectInteractiveGoalLimitNotice({
        objective: "Ship checkout",
        status: "budget_limited",
        statusReason: "budget reached",
        budget: {},
        usage: { turns: 1, tokens: 2, activeTimeMs: 3 },
      }),
      ...projectInteractiveSkillCatalogDegradationNotice({
        skills: [],
        total: 3,
        omitted: 3,
        budgetChars: 10,
        usedChars: 0,
      }),
      ...projectInteractiveSubagentProgressNotice({
        status: "turn",
        delegationId: "delegate-1",
        task: "Inspect renderer",
        turn: 2,
        elapsedMs: 50,
        deadlineMs: 1000,
      }),
      ...projectInteractiveUndoCheckpointWarningNotice(),
    ]);

    // Then
    expect(stdout).toBe("\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(stderr).toContain("Tool output artifact: artifact-123");
    expect(stderr).toContain("Context compaction failed: summary unavailable");
    expect(stderr).toContain(
      "Context compaction skipped: no safe history to compact.",
    );
    expect(stderr).toContain("Cost: $0.2500 (budget $1.0000)");
    expect(stderr).toContain("Session goal: budget_limited - Ship checkout");
    expect(stderr).toContain(
      "Warning: skill catalog budget exposed 0 of 3 implicit skills",
    );
    expect(stderr).toContain("Subagent delegate-1: turn 2");
    expect(stderr).toContain(
      "Warning: change applied; undo checkpoint unavailable for this task.",
    );
  });
});
