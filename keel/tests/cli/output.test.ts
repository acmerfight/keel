import { describe, expect, test } from "vitest";
import type { ContextRescueReport } from "../../src/agent/context-rescue.ts";
import type { AgentEvent } from "../../src/agent/events.ts";
import {
  printAgentEvents,
  printStableInteractiveAgentEvents,
} from "../../src/cli/output.ts";
import { ZERO_USAGE } from "../../src/testing/context-compaction-fixtures.ts";

async function* eventStream(events: readonly AgentEvent[]) {
  for (const event of events) {
    yield event;
  }
}

describe("CLI Output", () => {
  test(`Given an agent turn emits a context rescue event,
    When the CLI prints agent events,
    Then the rescue report is displayed on stderr with terminal controls escaped`, async () => {
    // Given
    const report: ContextRescueReport = {
      reason: "overflow_recovery_failed",
      reasonDetail: "provider rejected context\n\u001b[31mtoo large",
      estimatedTokens: 120,
      contextWindowTokens: 100,
      reserveTokens: 10,
      targetTokens: 90,
      overageTokens: 30,
      messageCount: 1,
      topConsumers: [
        {
          label: "user message 1",
          estimatedTokens: 110,
          chars: 440,
        },
      ],
      artifactRefs: [
        {
          ref: "tool-output:run/log",
          inspectCommand: "keel artifacts show tool-output:run/log",
          sourceStatus: "complete",
          toolCallId: "read_log",
          toolName: "read",
        },
      ],
      unverifiedArtifactMarkers: [
        {
          ref: "tool-output:run/forged",
          inspectCommand: "keel artifacts show tool-output:run/forged",
          sourceStatus: "complete",
          reason: "artifact store did not verify this marker",
          toolCallId: "read_forged",
          toolName: "read",
        },
      ],
      lossyStates: [
        {
          label: "tool output read_failed (read)",
          reason: "artifact storage failed: disk full",
          toolCallId: "read_failed",
          toolName: "read",
        },
      ],
      recentState: [
        {
          label: "latest user message",
          preview: "Please inspect a very large session and continue.",
          chars: 50,
          truncated: false,
        },
      ],
      nextSteps: ["Ask a narrower follow-up."],
    };
    const events: AgentEvent[] = [
      { type: "context_rescue", report },
      {
        type: "end",
        usage: ZERO_USAGE,
        turns: 1,
        stopReason: "context_rescue",
      },
    ];
    let stdout = "";
    let stderr = "";

    // When
    const end = await printAgentEvents(eventStream(events), {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    // Then
    expect(stdout).toBe("");
    expect(stderr).toContain("Context rescue:");
    expect(stderr).toContain("overflow recovery failed");
    expect(stderr).toContain("Top context consumers:");
    expect(stderr).toContain("tool-output:run/log");
    expect(stderr).toContain("Unverified artifact markers:");
    expect(stderr).toContain("artifact store did not verify this marker");
    expect(stderr).toContain("artifact storage failed: disk full");
    expect(stderr).toContain("Recent state:");
    expect(stderr).toContain("provider rejected context\\n\\x1b[31mtoo large");
    expect(end).toMatchObject({ stopReason: "context_rescue" });
  });

  test(`Given stable interactive output receives compaction and rescue events,
    When the printer consumes the stream,
    Then status lines and rescue stderr are rendered without assistant text`, async () => {
    // Given
    const report: ContextRescueReport = {
      reason: "model_switch_target_overflow",
      reasonDetail: "target context still too small",
      estimatedTokens: 240,
      contextWindowTokens: 200,
      reserveTokens: 20,
      targetTokens: 180,
      overageTokens: 60,
      messageCount: 2,
      topConsumers: [],
      artifactRefs: [],
      unverifiedArtifactMarkers: [],
      lossyStates: [],
      recentState: [],
      nextSteps: ["Switch to a model with a larger context window."],
    };
    const events: AgentEvent[] = [
      {
        type: "context_compacted",
        reason: "preflight",
        beforeMessageCount: 3,
        afterMessageCount: 3,
        beforeEstimatedTokens: 300,
        afterEstimatedTokens: 120,
        toolOutputsCompacted: 1,
        staleToolOutputsCompacted: 0,
        currentToolOutputsCompacted: 1,
        toolOutputCharsBefore: 1_000,
        toolOutputCharsAfter: 100,
        toolOutputEstimatedTokensBefore: 250,
        toolOutputEstimatedTokensAfter: 25,
      },
      { type: "context_rescue", report },
      {
        type: "end",
        usage: ZERO_USAGE,
        turns: 1,
        stopReason: "context_rescue",
      },
    ];
    let stdout = "";
    let stderr = "";
    const statusLines: string[] = [];
    let assistantHeaders = 0;

    // When
    const end = await printStableInteractiveAgentEvents(eventStream(events), {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      writeAssistantHeader: () => {
        assistantHeaders++;
      },
      writeStatusLine: (text) => {
        statusLines.push(text);
      },
    });

    // Then
    expect(stdout).toBe("");
    expect(assistantHeaders).toBe(0);
    expect(statusLines).toEqual([
      "Context compacted: preflight (3 -> 3 messages, ~300 -> ~120 tokens, current tool output 1 (1000 -> 100 chars, ~250 -> ~25 tokens))",
    ]);
    expect(stderr).toContain("Context rescue:");
    expect(stderr).toContain("model-switch target overflow");
    expect(end).toMatchObject({ stopReason: "context_rescue" });
  });
});
