import { describe, expect, test } from "vitest";
import {
  createInteractiveSessionDisplay,
  type InteractiveComposerMode,
  type InteractiveInputDisposition,
} from "../../../src/cli/interactive-session/display.ts";

describe("Interactive session display port", () => {
  test(`Given an interactive session display owns submitted-input state,
    When composer modes cross a command barrier,
    Then rendered input dispositions are derived without session-coordinator state`, async () => {
    // Given
    let stdout = "";
    let stderr = "";
    const composerModes: InteractiveComposerMode[] = [];
    const submissions: {
      readonly line: string;
      readonly disposition: InteractiveInputDisposition;
    }[] = [];
    const display = createInteractiveSessionDisplay({
      output: {
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      },
      controls: {
        setComposerMode: (mode) => {
          composerModes.push(mode);
        },
        renderSubmittedInput: (line, disposition) => {
          submissions.push({ line, disposition });
        },
      },
      printAgentEvents: async (stream) => {
        for await (const event of stream) {
          if (event.type === "text") stdout += event.text;
          if (event.type === "end") return event;
        }
        return undefined;
      },
    });

    // When
    display.writeStdout("visible stdout\n");
    display.writeStderr("visible stderr\n");
    display.renderCommandOutput([
      { type: "stdout", text: "command stdout\n" },
      { type: "stderr", text: "command stderr\n" },
    ]);
    display.renderProgressOutput([
      {
        type: "cost_report",
        cost: {
          spentUsd: 2,
          budget: { kind: "unbounded" },
        },
        text: "Cost: $2.0000\n",
      },
    ]);
    display.setComposerMode("steer");
    display.renderSubmittedInput("guide this turn");
    display.renderSubmittedInput("/status");
    display.setComposerMode("approval");
    display.renderSubmittedInput("");
    display.setComposerMode("ready");
    display.renderSubmittedInput("next prompt");
    const finalEnd = await display.printAgentEvents(
      (async function* () {
        yield { type: "text", text: "agent text" } as const;
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
        } as const;
      })(),
    );

    // Then
    expect(stdout).toBe("visible stdout\ncommand stdout\nagent text");
    expect(stderr).toBe("visible stderr\ncommand stderr\nCost: $2.0000\n");
    expect(composerModes).toEqual(["steer", "approval", "ready"]);
    expect(submissions).toEqual([
      { line: "guide this turn", disposition: "steer/next" },
      { line: "/status", disposition: "queue" },
      { line: "", disposition: "approve" },
      { line: "next prompt", disposition: "keel" },
    ]);
    expect(finalEnd?.turns).toBe(1);
  });
});
